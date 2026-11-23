// main.ts is mend, implementing SPEC.md (version 1) for unified diffs, SEARCH/REPLACE blocks,
// V4A patches, and JSON edits. Node 22 standard library only.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and the hand-over
// at the bottom delegates to runner.ts.

import { mkdirSync, readFileSync, rmdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseJsonEdits } from './lib/json.ts';
import { parseSearchReplaceEdits } from './lib/search-replace.ts';
import { byteOrder, Exit2, Fail, isBlank, patchLines, Tree } from './lib/types.ts';
import type { Edit } from './lib/types.ts';
import { parseUnifiedEdits } from './lib/unified.ts';
import { parseV4aEdits } from './lib/v4a.ts';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'] as const;

function detectFormat(lines: readonly string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

function parsePatch(kind: string, text: string, lines: readonly string[], strict: boolean): Edit[] {
  if (kind === 'json') return parseJsonEdits(text, lines);
  if (kind === 'search-replace') return parseSearchReplaceEdits(lines, strict);
  if (kind === 'unified') return parseUnifiedEdits(lines, strict);
  if (kind === 'v4a') return parseV4aEdits(lines, strict);
  return [];
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;

  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && (FORMATS as readonly string[]).includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }

  if (pos.length > 1) return { code: 2, out: ['error: usage'] };

  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }

  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    edits = parsePatch(kind, text, lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new Tree();
  const fails: Fail[] = [];

  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }

  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }

  const added = new Set<string>();
  const deleted = new Set<string>();
  const modified = new Set<string>();

  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null) added.add(p);
    else if (now === null) deleted.add(p);
    else modified.add(p);
  }

  const reportRows: Array<{ key: string; line: string }> = [];
  const pairedOld = new Set<string>();
  const pairedNew = new Set<string>();

  for (const [oldPath, newPath] of tree.moves) {
    if (
      deleted.has(oldPath) &&
      added.has(newPath) &&
      !pairedOld.has(oldPath) &&
      !pairedNew.has(newPath)
    ) {
      pairedOld.add(oldPath);
      pairedNew.add(newPath);
      reportRows.push({ key: newPath, line: `R ${oldPath} -> ${newPath}` });
    }
  }

  for (const p of added) {
    if (!pairedNew.has(p)) reportRows.push({ key: p, line: `A ${p}` });
  }
  for (const p of deleted) {
    if (!pairedOld.has(p)) reportRows.push({ key: p, line: `D ${p}` });
  }
  for (const p of modified) {
    reportRows.push({ key: p, line: `M ${p}` });
  }

  reportRows.sort((a, b) => byteOrder(a.key, b.key));

  if (!check) {
    // Delete removed files first and prune any emptied ancestor directories so
    // replacing a directory's files with a regular file at the directory's path succeeds.
    for (const p of [...deleted].sort(byteOrder)) {
      rmSync(p, { force: true });
      let dir = dirname(p);
      while (dir !== '.' && dir !== '' && dir !== '/') {
        try {
          rmdirSync(dir);
        } catch {
          break;
        }
        dir = dirname(dir);
      }
    }
    for (const p of [...added, ...modified].sort(byteOrder)) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, tree.now.get(p)!);
    }
  }

  const rows = reportRows.map((r) => r.line);
  return {
    code: 0,
    out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`],
  };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
