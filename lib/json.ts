import { Exit2, Fail, isBlank, joinFile, patchLines, safePath, splitFile } from './types.ts';
import type { Edit, Tree } from './types.ts';

function parseJsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  const requireExisting = (tree: Tree): string => {
    if (!safePath(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };

  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }

  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = requireExisting(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const textLf = toLf(before);
      const oldLf = toLf(oldStr);
      const firstAt = textLf.indexOf(oldLf);
      if (firstAt < 0) throw new Fail('no-match', p);
      if (textLf.indexOf(oldLf, firstAt + 1) >= 0) throw new Fail('ambiguous', p);
      const out = textLf.slice(0, firstAt) + toLf(newStr) + textLf.slice(firstAt + oldLf.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const insertLine = o.insert_line;
    const addLines = patchLines(o.new_str);
    return (tree) => {
      const before = requireExisting(tree);
      const file = splitFile(before);
      if (insertLine < 0 || insertLine > file.lines.length) throw new Fail('no-match', p);
      file.lines.splice(insertLine, 0, ...addLines);
      tree.now.set(p, joinFile(file.lines, file.br, file.finalBreak));
    };
  }

  return null;
}

export function parseJsonEdits(text: string, lines: readonly string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');

  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(parsed)) throw new Exit2(`error: parse ${first + 1}`);
    for (const item of parsed) {
      const edit = parseJsonEdit(item);
      if (edit === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(edit);
    }
    return edits;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (isBlank(l)) continue;
    let edit: Edit | null = null;
    try {
      edit = parseJsonEdit(JSON.parse(l));
    } catch {
      edit = null;
    }
    if (edit === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(edit);
  }

  return edits;
}
