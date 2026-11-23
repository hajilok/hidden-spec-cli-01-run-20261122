import { findOccurrences, renderSearchReplace } from './match.ts';
import { Exit2, Fail, joinFile, safePath, splitFile } from './types.ts';
import type { Edit } from './types.ts';

interface SearchReplaceBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

export function parseSearchReplaceEdits(lines: readonly string[], strict: boolean): Edit[] {
  const blocks: SearchReplaceBlock[] = [];
  let prevEnd = -1;
  let lastPath: string | null = null;
  let i = 0;

  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }

    const searchIdx = i;
    const searchLineNo = searchIdx + 1;

    // Resolve path: nearest non-blank line before SEARCH and after prevEnd
    // that does not start with three backticks after trimming.
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const trimmed = lines[j]!.trim();
      if (trimmed === '' || trimmed.startsWith('```')) continue;
      path = trimmed;
      break;
    }
    if (path === null) {
      if (lastPath !== null) path = lastPath;
      else throw new Exit2(`error: parse ${searchLineNo}`);
    }

    // Find =======
    let sepIdx = -1;
    for (let k = searchIdx + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        sepIdx = k;
        break;
      }
    }
    if (sepIdx < 0) throw new Exit2(`error: parse ${searchLineNo}`);

    // Find >>>>>>> REPLACE
    let endIdx = -1;
    for (let k = sepIdx + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        endIdx = k;
        break;
      }
    }
    if (endIdx < 0) throw new Exit2(`error: parse ${searchLineNo}`);

    blocks.push({
      path,
      oldLines: lines.slice(searchIdx + 1, sepIdx),
      newLines: lines.slice(sepIdx + 1, endIdx),
    });

    lastPath = path;
    prevEnd = endIdx;
    i = endIdx + 1;
  }

  return blocks.map((block): Edit => {
    return (tree) => {
      if (!safePath(block.path)) throw new Fail('unsafe', block.path);
      if (block.oldLines.length === 0) {
        if (tree.get(block.path) !== null) throw new Fail('exists', block.path);
        tree.now.set(block.path, joinFile(block.newLines, '\n', true));
        return;
      }

      const before = tree.get(block.path);
      if (before === null) throw new Fail('missing', block.path);
      const file = splitFile(before);
      const found = findOccurrences(file.lines, block.oldLines, 0, strict);
      if (found === null) throw new Fail('no-match', block.path);
      if (found.positions.length > 1) throw new Fail('ambiguous', block.path);

      const pos = found.positions[0]!;
      const replacement = renderSearchReplace(
        block.newLines,
        file.lines,
        pos,
        found.tier,
        block.oldLines[0]!,
      );
      file.lines.splice(pos, block.oldLines.length, ...replacement);
      tree.now.set(block.path, joinFile(file.lines, file.br, file.finalBreak));
    };
  });
}
