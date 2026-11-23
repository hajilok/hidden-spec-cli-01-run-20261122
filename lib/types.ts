import { readFileSync, statSync } from 'node:fs';

export class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

export class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

export type LineBreak = '\r\n' | '\n';

export interface FileLines {
  lines: string[];
  br: LineBreak;
  finalBreak: boolean;
}

export interface BodyItem {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  noNewline: boolean;
}

export type Edit = (tree: Tree) => void;

export const isBlank = (s: string): boolean => s.trim() === '';

export const stripSpaces = (s: string): string => s.replace(/^ +| +$/g, '');

export function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

export function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  const parts = p.split('/');
  for (const s of parts) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

export function splitFile(text: string): FileLines {
  const nl = text.indexOf('\n');
  const br: LineBreak = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, finalBreak: false };
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

export function joinFile(lines: readonly string[], br: LineBreak, finalBreak: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBreak ? br : '');
}

export function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Virtual file tree tracking original on-disk contents, pending mutations (null = deleted),
 * and successful move pairs [oldPath, newPath] for exit-0 reporting.
 */
export class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}
