import { findOccurrences, renderBodyReplacement } from './match.ts';
import { Exit2, Fail, joinFile, safePath, splitFile, stripSpaces } from './types.ts';
import type { BodyItem, Edit } from './types.ts';

interface UnifiedHunk {
  oldStart: number;
  items: BodyItem[];
}

interface UnifiedSection {
  gitOld: string | null;
  gitNew: string | null;
  minusPath: string | null;
  plusPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isNewFile: boolean;
  isDeletedFile: boolean;
  hasMinusPlus: boolean;
  hunks: UnifiedHunk[];
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseDiffGit(line: string): [string, string] | null {
  const trimmed = line.replace(/ +$/, '');
  if (!trimmed.startsWith('diff --git ')) return null;
  const rest = trimmed.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const afterA = rest.slice(2);

  // If old === new (including paths that may contain " b/"), check exact symmetry first.
  if (afterA.length >= 4 && (afterA.length - 3) % 2 === 0) {
    const half = (afterA.length - 3) / 2;
    if (
      half > 0 &&
      afterA.slice(half, half + 3) === ' b/' &&
      afterA.slice(0, half) === afterA.slice(half + 3)
    ) {
      const p = afterA.slice(0, half);
      return [p, p];
    }
  }

  const sep = afterA.indexOf(' b/');
  if (sep <= 0) return null;
  const x = afterA.slice(0, sep);
  const y = afterA.slice(sep + 3);
  if (y === '') return null;
  return [x, y];
}

function parseHeaderPath(line: string): string {
  let raw = line.slice(4);
  const tab = raw.indexOf('\t');
  if (tab >= 0) raw = raw.slice(0, tab);
  raw = stripSpaces(raw);
  if (raw === '/dev/null') return '/dev/null';
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function newSection(): UnifiedSection {
  return {
    gitOld: null,
    gitNew: null,
    minusPath: null,
    plusPath: null,
    renameFrom: null,
    renameTo: null,
    isNewFile: false,
    isDeletedFile: false,
    hasMinusPlus: false,
    hunks: [],
  };
}

function applyHunksToContent(
  before: string,
  hunks: readonly UnifiedHunk[],
  targetPath: string,
  strict: boolean,
): string {
  const file = splitFile(before);
  let delta = 0;

  for (const hunk of hunks) {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let lastNNoNewline = false;

    for (const item of hunk.items) {
      if (item.kind === 'ctx') {
        oldLines.push(item.text);
        newLines.push(item.text);
        lastNNoNewline = item.noNewline;
      } else if (item.kind === 'del') {
        oldLines.push(item.text);
      } else {
        newLines.push(item.text);
        lastNNoNewline = item.noNewline;
      }
    }

    if (oldLines.length === 0) {
      const insertAt = Math.max(0, Math.min(file.lines.length, hunk.oldStart + delta));
      const atEnd = insertAt === file.lines.length;
      file.lines.splice(insertAt, 0, ...newLines);
      if (atEnd) file.finalBreak = !lastNNoNewline;
      delta += newLines.length;
      continue;
    }

    const found = findOccurrences(file.lines, oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', targetPath);

    const target = hunk.oldStart - 1 + delta;
    let bestPos = found.positions[0]!;
    let bestDist = Math.abs(bestPos - target);
    for (let k = 1; k < found.positions.length; k += 1) {
      const pos = found.positions[k]!;
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        bestPos = pos;
        bestDist = dist;
      }
    }

    const atEnd = bestPos + oldLines.length === file.lines.length;
    const replacement = renderBodyReplacement(
      hunk.items,
      file.lines,
      bestPos,
      found.tier,
      oldLines[0]!,
    );
    file.lines.splice(bestPos, oldLines.length, ...replacement);
    if (atEnd) file.finalBreak = !lastNNoNewline;
    delta += replacement.length - oldLines.length;
  }

  return joinFile(file.lines, file.br, file.finalBreak);
}

export function parseUnifiedEdits(lines: readonly string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let current: UnifiedSection | null = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Start of section via `diff --git`
    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const pair = parseDiffGit(line);
      if (pair === null) throw new Exit2(`error: parse ${i + 1}`);
      current = newSection();
      current.gitOld = pair[0];
      current.gitNew = pair[1];
      sections.push(current);
      i += 1;
      continue;
    }

    // `--- ` header handling
    if (line.startsWith('--- ')) {
      const nextIsPlus = i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ');
      if (current !== null && current.hunks.length === 0) {
        // Inside a section's header (before its first hunk)
        if (!nextIsPlus) throw new Exit2(`error: parse ${i + 2}`);
        if (current.hasMinusPlus) {
          current = newSection();
          sections.push(current);
        }
        current.minusPath = parseHeaderPath(line);
        current.plusPath = parseHeaderPath(lines[i + 1]!);
        current.hasMinusPlus = true;
        i += 2;
        continue;
      }
      // Outside a section header: starts a new section only if followed by `+++ `
      if (nextIsPlus) {
        current = newSection();
        current.minusPath = parseHeaderPath(line);
        current.plusPath = parseHeaderPath(lines[i + 1]!);
        current.hasMinusPlus = true;
        sections.push(current);
        i += 2;
        continue;
      }
      // Otherwise ignored as prose
      i += 1;
      continue;
    }

    // Hunk header
    if (line.startsWith('@@')) {
      if (current === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEADER_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const oldStart = Number(m[1]!);
      i += 1;

      const rawBody: string[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) {
          break;
        }
        if (
          bl === '' ||
          bl.startsWith(' ') ||
          bl.startsWith('-') ||
          bl.startsWith('+') ||
          bl.startsWith('\\')
        ) {
          rawBody.push(bl);
          i += 1;
        } else {
          break;
        }
      }

      // Empty lines at the end of a body are not part of it.
      while (rawBody.length > 0 && rawBody[rawBody.length - 1] === '') {
        rawBody.pop();
      }

      const items: BodyItem[] = [];
      for (const bl of rawBody) {
        if (bl === '') {
          items.push({ kind: 'ctx', text: '', noNewline: false });
        } else if (bl.startsWith(' ')) {
          items.push({ kind: 'ctx', text: bl.slice(1), noNewline: false });
        } else if (bl.startsWith('-')) {
          items.push({ kind: 'del', text: bl.slice(1), noNewline: false });
        } else if (bl.startsWith('+')) {
          items.push({ kind: 'add', text: bl.slice(1), noNewline: false });
        } else if (bl.startsWith('\\')) {
          if (items.length > 0) {
            items[items.length - 1]!.noNewline = true;
          }
        }
      }

      current.hunks.push({ oldStart, items });
      continue;
    }

    // Section header metadata lines (only before first hunk)
    if (current !== null && current.hunks.length === 0) {
      if (line.startsWith('rename from ')) {
        current.renameFrom = stripSpaces(line.slice('rename from '.length));
      } else if (line.startsWith('rename to ')) {
        current.renameTo = stripSpaces(line.slice('rename to '.length));
      } else if (line === 'new file mode' || line.startsWith('new file mode ')) {
        current.isNewFile = true;
      } else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        current.isDeletedFile = true;
      }
    }

    i += 1;
  }

  return sections.map((sec): Edit => {
    const oldPath = sec.minusPath ?? sec.renameFrom ?? sec.gitOld ?? '';
    const newPath = sec.plusPath ?? sec.renameTo ?? sec.gitNew ?? '';
    const isCreate = oldPath === '/dev/null' || sec.isNewFile;
    const isDelete = !isCreate && (newPath === '/dev/null' || sec.isDeletedFile);

    if (isCreate) {
      return (tree) => {
        if (!safePath(newPath)) throw new Fail('unsafe', newPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const added: string[] = [];
        let lastNoNewline = false;
        for (const h of sec.hunks) {
          for (const item of h.items) {
            if (item.kind === 'add') {
              added.push(item.text);
              lastNoNewline = item.noNewline;
            }
          }
        }
        tree.now.set(newPath, joinFile(added, '\n', !lastNoNewline));
      };
    }

    if (isDelete) {
      return (tree) => {
        if (!safePath(oldPath)) throw new Fail('unsafe', oldPath);
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
      };
    }

    if (oldPath !== newPath) {
      return (tree) => {
        if (!safePath(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safePath(newPath)) throw new Fail('unsafe', newPath);
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const after = applyHunksToContent(before, sec.hunks, oldPath, strict);
        tree.now.set(oldPath, null);
        tree.now.set(newPath, after);
        tree.moves.push([oldPath, newPath]);
      };
    }

    return (tree) => {
      if (!safePath(oldPath)) throw new Fail('unsafe', oldPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      const after = applyHunksToContent(before, sec.hunks, oldPath, strict);
      tree.now.set(oldPath, after);
    };
  });
}
