import { isBlank } from './types.ts';
import type { BodyItem } from './types.ts';

export type Tier = 0 | 1 | 2;

export interface MatchResult {
  tier: Tier;
  positions: number[];
}

export function normalizeLine(s: string, tier: Tier): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+|[ \t]+$/g, '');
}

export function leadingSpacesTabs(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return s.slice(0, i);
}

export function reindentLine(line: string, pIndent: string, fIndent: string): string {
  if (line === '' || isBlank(line)) return line;
  if (line.startsWith(pIndent)) return fIndent + line.slice(pIndent.length);
  return line;
}

/**
 * Find all occurrences (overlapping allowed) of `needle` (length >= 1) in `fileLines`
 * starting at index >= `startAt`, at the first tier (0, 1, 2; or only 0 when `strict`)
 * that yields at least one match. When `endAtEof` is true, only the single position
 * ending at `fileLines.length` is tested.
 */
export function findOccurrences(
  fileLines: readonly string[],
  needle: readonly string[],
  startAt: number,
  strict: boolean,
  endAtEof = false,
): MatchResult | null {
  const n = needle.length;
  if (n === 0) return null;
  const maxTier: Tier = strict ? 0 : 2;

  if (endAtEof) {
    const pos = fileLines.length - n;
    if (pos < startAt) return null;
    for (let t = 0; t <= maxTier; t += 1) {
      const tier = t as Tier;
      let ok = true;
      for (let k = 0; k < n; k += 1) {
        if (normalizeLine(fileLines[pos + k]!, tier) !== normalizeLine(needle[k]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) return { tier, positions: [pos] };
    }
    return null;
  }

  const lastStart = fileLines.length - n;
  if (lastStart < startAt) return null;

  for (let t = 0; t <= maxTier; t += 1) {
    const tier = t as Tier;
    const normNeedle = needle.map((l) => normalizeLine(l, tier));
    const normFile = tier === 0 ? fileLines : fileLines.map((l) => normalizeLine(l, tier));
    const positions: number[] = [];
    for (let i = startAt; i <= lastStart; i += 1) {
      if (normFile[i]! !== normNeedle[0]!) continue;
      let ok = true;
      for (let k = 1; k < n; k += 1) {
        if (normFile[i + k]! !== normNeedle[k]!) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }

  return null;
}

/**
 * Find the first single line equal to `anchor` at or after `startAt`,
 * at the first matching tier (0, 1, 2; or only 0 when `strict`).
 */
export function findFirstAnchor(
  fileLines: readonly string[],
  anchor: string,
  startAt: number,
  strict: boolean,
): number {
  const maxTier: Tier = strict ? 0 : 2;
  for (let t = 0; t <= maxTier; t += 1) {
    const tier = t as Tier;
    const normAnchor = normalizeLine(anchor, tier);
    for (let i = startAt; i < fileLines.length; i += 1) {
      if (normalizeLine(fileLines[i]!, tier) === normAnchor) return i;
    }
  }
  return -1;
}

/**
 * Render replacement lines for a unified hunk or V4A chunk:
 * context lines keep the file's exact matched line; added lines are re-indented at tier 2.
 */
export function renderBodyReplacement(
  items: readonly BodyItem[],
  fileLines: readonly string[],
  matchPos: number,
  tier: Tier,
  oldFirstLine: string,
): string[] {
  const fIndent = leadingSpacesTabs(fileLines[matchPos]!);
  const pIndent = leadingSpacesTabs(oldFirstLine);
  const out: string[] = [];
  let oIdx = 0;
  for (const item of items) {
    if (item.kind === 'ctx') {
      out.push(fileLines[matchPos + oIdx]!);
      oIdx += 1;
    } else if (item.kind === 'del') {
      oIdx += 1;
    } else {
      out.push(tier === 2 ? reindentLine(item.text, pIndent, fIndent) : item.text);
    }
  }
  return out;
}

/**
 * Render replacement lines for a SEARCH/REPLACE block (no context lines).
 */
export function renderSearchReplace(
  newLines: readonly string[],
  fileLines: readonly string[],
  matchPos: number,
  tier: Tier,
  oldFirstLine: string,
): string[] {
  if (tier !== 2) return [...newLines];
  const fIndent = leadingSpacesTabs(fileLines[matchPos]!);
  const pIndent = leadingSpacesTabs(oldFirstLine);
  return newLines.map((l) => reindentLine(l, pIndent, fIndent));
}
