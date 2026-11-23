import { findFirstAnchor, findOccurrences, renderBodyReplacement } from './match.ts';
import { Exit2, Fail, isBlank, joinFile, safePath, splitFile, stripSpaces } from './types.ts';
import type { BodyItem, Edit } from './types.ts';

interface RawLine {
  lineNo: number;
  text: string;
}

interface V4aChunk {
  anchor: string | null;
  items: BodyItem[];
  eof: boolean;
}

interface RawV4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  headerLineNo: number;
  body: RawLine[];
}

const ADD_PREFIX = '*** Add File: ';
const DEL_PREFIX = '*** Delete File: ';
const UPD_PREFIX = '*** Update File: ';
const MOVE_PREFIX = '*** Move to: ';

function parseSectionHeader(line: string, lineNo: number): RawV4aSection | null {
  if (line.startsWith(ADD_PREFIX)) {
    return { kind: 'add', path: stripSpaces(line.slice(ADD_PREFIX.length)), headerLineNo: lineNo, body: [] };
  }
  if (line.startsWith(DEL_PREFIX)) {
    return { kind: 'delete', path: stripSpaces(line.slice(DEL_PREFIX.length)), headerLineNo: lineNo, body: [] };
  }
  if (line.startsWith(UPD_PREFIX)) {
    return { kind: 'update', path: stripSpaces(line.slice(UPD_PREFIX.length)), headerLineNo: lineNo, body: [] };
  }
  return null;
}

function isBodyLine(text: string): boolean {
  return text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+');
}

function toBodyItem(text: string): BodyItem {
  if (text === '') return { kind: 'ctx', text: '', noNewline: false };
  if (text.startsWith(' ')) return { kind: 'ctx', text: text.slice(1), noNewline: false };
  if (text.startsWith('-')) return { kind: 'del', text: text.slice(1), noNewline: false };
  return { kind: 'add', text: text.slice(1), noNewline: false };
}

export function parseV4aEdits(lines: readonly string[], strict: boolean): Edit[] {
  const firstNonBlank = lines.findIndex((l) => !isBlank(l));
  if (firstNonBlank < 0) throw new Exit2('error: parse 1');
  if (lines[firstNonBlank]!.trim() !== '*** Begin Patch') {
    throw new Exit2(`error: parse ${firstNonBlank + 1}`);
  }

  let lastNonBlank = lines.length - 1;
  while (lastNonBlank >= 0 && isBlank(lines[lastNonBlank]!)) lastNonBlank -= 1;
  if (lastNonBlank === firstNonBlank || lines[lastNonBlank]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }

  const rawSections: RawV4aSection[] = [];
  let current: RawV4aSection | null = null;

  for (let i = firstNonBlank + 1; i < lastNonBlank; i += 1) {
    const line = lines[i]!;
    const lineNo = i + 1;
    const header = parseSectionHeader(line, lineNo);
    if (header !== null) {
      current = header;
      rawSections.push(current);
      continue;
    }
    if (current === null) {
      if (isBlank(line)) continue;
      throw new Exit2(`error: parse ${lineNo}`);
    }
    current.body.push({ lineNo, text: line });
  }

  // Blank lines at the end of a section (before the next section or *** End Patch) are not part of it.
  for (const sec of rawSections) {
    while (sec.body.length > 0 && isBlank(sec.body[sec.body.length - 1]!.text)) {
      sec.body.pop();
    }
  }

  const edits: Edit[] = [];

  for (const sec of rawSections) {
    if (sec.kind === 'add') {
      const fileLines: string[] = [];
      for (const { lineNo, text } of sec.body) {
        if (text.startsWith('+')) fileLines.push(text.slice(1));
        else if (text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${lineNo}`);
      }
      const targetPath = sec.path;
      edits.push((tree) => {
        if (!safePath(targetPath)) throw new Fail('unsafe', targetPath);
        if (tree.get(targetPath) !== null) throw new Fail('exists', targetPath);
        tree.now.set(targetPath, joinFile(fileLines, '\n', true));
      });
      continue;
    }

    if (sec.kind === 'delete') {
      if (sec.body.length > 0) throw new Exit2(`error: parse ${sec.body[0]!.lineNo}`);
      const targetPath = sec.path;
      edits.push((tree) => {
        if (!safePath(targetPath)) throw new Fail('unsafe', targetPath);
        if (tree.get(targetPath) === null) throw new Fail('missing', targetPath);
        tree.now.set(targetPath, null);
      });
      continue;
    }

    // Update File section
    let idx = 0;
    let moveTo: string | null = null;
    if (idx < sec.body.length && sec.body[idx]!.text.startsWith(MOVE_PREFIX)) {
      moveTo = stripSpaces(sec.body[idx]!.text.slice(MOVE_PREFIX.length));
      idx += 1;
    }

    const chunks: V4aChunk[] = [];
    while (idx < sec.body.length) {
      const entry = sec.body[idx]!;
      let chunk: V4aChunk;

      if (entry.text.startsWith('@@')) {
        const anchorText = stripSpaces(entry.text.slice(2));
        chunk = { anchor: anchorText === '' ? null : anchorText, items: [], eof: false };
        idx += 1;
      } else if (chunks.length === 0 && isBodyLine(entry.text)) {
        chunk = { anchor: null, items: [], eof: false };
      } else {
        throw new Exit2(`error: parse ${entry.lineNo}`);
      }

      while (idx < sec.body.length) {
        const line = sec.body[idx]!;
        if (line.text.startsWith('@@')) break;
        if (line.text === '*** End of File') {
          chunk.eof = true;
          idx += 1;
          break;
        }
        if (isBodyLine(line.text)) {
          chunk.items.push(toBodyItem(line.text));
          idx += 1;
        } else {
          throw new Exit2(`error: parse ${line.lineNo}`);
        }
      }

      chunks.push(chunk);
    }

    if (chunks.length === 0 && moveTo === null) {
      throw new Exit2(`error: parse ${sec.headerLineNo}`);
    }

    const oldPath = sec.path;
    const newPath = moveTo;
    edits.push((tree) => {
      if (!safePath(oldPath)) throw new Fail('unsafe', oldPath);
      if (newPath !== null && !safePath(newPath)) throw new Fail('unsafe', newPath);

      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (newPath !== null && tree.get(newPath) !== null) throw new Fail('exists', newPath);

      const file = splitFile(before);
      let cursor = 0;

      for (const chunk of chunks) {
        if (chunk.anchor !== null) {
          const anchorIdx = findFirstAnchor(file.lines, chunk.anchor, cursor, strict);
          if (anchorIdx < 0) throw new Fail('no-match', oldPath);
          cursor = anchorIdx + 1;
        }

        const oldLines: string[] = [];
        const newLines: string[] = [];
        for (const item of chunk.items) {
          if (item.kind === 'ctx') {
            oldLines.push(item.text);
            newLines.push(item.text);
          } else if (item.kind === 'del') {
            oldLines.push(item.text);
          } else {
            newLines.push(item.text);
          }
        }

        if (oldLines.length === 0) {
          const insertAt = chunk.eof ? file.lines.length : cursor;
          file.lines.splice(insertAt, 0, ...newLines);
          cursor = insertAt + newLines.length;
          continue;
        }

        const found = findOccurrences(file.lines, oldLines, cursor, strict, chunk.eof);
        if (found === null) throw new Fail('no-match', oldPath);

        const pos = found.positions[0]!;
        const replacement = renderBodyReplacement(
          chunk.items,
          file.lines,
          pos,
          found.tier,
          oldLines[0]!,
        );
        file.lines.splice(pos, oldLines.length, ...replacement);
        cursor = pos + replacement.length;
      }

      const after = joinFile(file.lines, file.br, file.finalBreak);
      if (newPath !== null) {
        tree.now.set(oldPath, null);
        tree.now.set(newPath, after);
        tree.moves.push([oldPath, newPath]);
      } else {
        tree.now.set(oldPath, after);
      }
    });
  }

  return edits;
}
