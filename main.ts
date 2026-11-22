// mend: one patch tool for every AI edit format.
//
// Applies an edit an AI model wrote to a tree of text files. Models write
// edits in four formats: unified diffs, SEARCH/REPLACE blocks, V4A patches
// and JSON tool calls. Every file is changed or nothing is.
//
// Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// See SPEC.md for the full specification. Node 22 standard library only.
//
// When MAKEFUN_ENV_URL is set, main.ts hands the trial over to runner.ts
// (runTrial) instead of running as a CLI.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, lstatSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

type Brk = '\r\n' | '\n';

/** A file as lines plus its own line break and final-break state. */
interface Doc {
  lines: string[];
  brk: Brk;
  eol: boolean;
}

/** Parse raw file text into a Doc (SPEC section 3). */
function parseDoc(text: string): Doc {
  if (text === '') return { lines: [], brk: '\n', eol: false };
  const firstLf = text.indexOf('\n');
  const brk: Brk = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(brk);
  const eol = text.endsWith(brk);
  if (eol) parts.pop();
  return { lines: parts, brk, eol };
}

/** Serialize a Doc back to text. A file of no lines is written empty. */
function serializeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.brk) + (d.eol ? d.brk : '');
}

/** One body line of a hunk / chunk / block. */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'mark';
  text: string;
}

function bodyItem(raw: string): BodyItem {
  if (raw === '') return { kind: 'ctx', text: '' };
  const c = raw[0];
  if (c === ' ') return { kind: 'ctx', text: raw.slice(1) };
  if (c === '-') return { kind: 'old', text: raw.slice(1) };
  if (c === '+') return { kind: 'new', text: raw.slice(1) };
  return { kind: 'mark', text: raw.slice(1) };
}

/** A failed edit: its code and the path it concerns. */
class Fail extends Error {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

/** A patch that cannot be read in its format, at a 1-based patch line. */
class ParseFail extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

/** A path is safe when it is not empty, does not start with `/`, holds no
 * `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function checkSafe(p: string): void {
  if (!isSafePath(p)) throw new Fail('unsafe', p);
}

/* ------------------------------------------------------------------ */
/* Tier matching (SPEC section 5)                                      */
/* ------------------------------------------------------------------ */

function stripTrailing(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function lineMatches(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailing(a) === stripTrailing(b);
  return stripBoth(a) === stripBoth(b);
}

/** Positions at or after `from` where `oldLines` occurs at `tier`. */
function occurrencesAt(lines: string[], oldLines: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  for (let i = from; i + oldLines.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (!lineMatches(lines[i + j], oldLines[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2) at which `oldLines` occurs at or
 * after `from`, with its occurrences; null when it occurs at no tier. */
function findTier(lines: string[], oldLines: string[], from = 0): { tier: number; occ: number[] } | null {
  for (let t = 0; t <= 2; t++) {
    const occ = occurrencesAt(lines, oldLines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to `line` at the first tier
 * where one is (single-line matching); null when there is none. */
function findTierSingle(lines: string[], line: string, from = 0): number | null {
  for (let t = 0; t <= 2; t++) {
    for (let i = from; i < lines.length; i++) {
      if (lineMatches(lines[i], line, t)) return i;
    }
  }
  return null;
}

/**
 * Apply body items at position `pos` of `lines` and return the new lines.
 * Context lines are written as the file's own matched lines. At tier 2
 * every other line of N is re-indented: the leading spaces and tabs of the
 * file's first matched line (F) replace those of O's first line (P) where
 * the new line starts with P.
 */
function applyItems(lines: string[], items: BodyItem[], pos: number, tier: number): string[] {
  const result = lines.slice(0, pos);
  let j = pos;
  const firstOld = items.find((i) => i.kind === 'ctx' || i.kind === 'old');
  const firstFile = pos < lines.length ? lines[pos] : '';
  for (const it of items) {
    if (it.kind === 'ctx') {
      result.push(lines[j]);
      j++;
    } else if (it.kind === 'old') {
      j++;
    } else if (it.kind === 'new') {
      if (tier === 2 && firstOld !== undefined) {
        const f = leadingWs(firstFile);
        const p = leadingWs(firstOld.text);
        const l = it.text;
        if (l !== '' && !/^[ \t]+$/.test(l) && l.startsWith(p)) result.push(f + l.slice(p.length));
        else result.push(l);
      } else {
        result.push(it.text);
      }
    }
    // 'mark' items write nothing.
  }
  result.push(...lines.slice(j));
  return result;
}

/* ------------------------------------------------------------------ */
/* The tree                                                            */
/* ------------------------------------------------------------------ */

type Tree = Map<string, Doc>;

function cloneTree(t: Tree): Tree {
  const out: Tree = new Map();
  for (const [k, d] of t) out.set(k, { lines: [...d.lines], brk: d.brk, eol: d.eol });
  return out;
}

/** Read every regular file under `dir`, keyed by `/`-separated path. */
function readTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.set(relative(dir, p).split(sep).join('/'), readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return out;
}

/** Write the files that changed and delete the ones that are gone. */
function writeTree(initial: Map<string, string>, finalTree: Tree): void {
  const cwd = process.cwd();
  for (const [p, doc] of finalTree) {
    const text = serializeDoc(doc);
    if (initial.get(p) !== text) {
      const f = join(cwd, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text, 'utf8');
    }
  }
  for (const p of initial.keys()) {
    if (!finalTree.has(p)) unlinkSync(join(cwd, ...p.split('/')));
  }
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/* ------------------------------------------------------------------ */
/* Command line, patch reading, format detection (SPEC sections 1, 4)  */
/* ------------------------------------------------------------------ */

interface Options {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

/** Parse the arguments; null on a usage error. */
function parseArgs(argv: string[]): Options | null {
  let format = 'auto';
  let formatSeen = false;
  let check = false;
  let checkSeen = false;
  let strict = false;
  let strictSeen = false;
  let patch: string | null = null;
  let noMoreOptions = false;
  for (const a of argv) {
    if (!noMoreOptions && a === '--') {
      noMoreOptions = true;
      continue;
    }
    if (!noMoreOptions && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (formatSeen) return null;
        formatSeen = true;
        const v = a.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') return null;
        format = v;
      } else if (a === '--check') {
        if (checkSeen) return null;
        checkSeen = true;
        check = true;
      } else if (a === '--strict') {
        if (strictSeen) return null;
        strictSeen = true;
        strict = true;
      } else {
        return null;
      }
    } else {
      if (patch !== null) return null;
      patch = a;
    }
  }
  return { format, check, strict, patch };
}

/** Read the patch (stdin when PATCH is absent or `-`); null when it cannot
 * be read. */
function readPatch(patch: string | null): string | null {
  try {
    if (patch === null || patch === '-') return readFileSync(0, 'utf8');
    return readFileSync(patch, 'utf8');
  } catch {
    return null;
  }
}

/** A text split at `\n`, each line with one trailing `\r` removed, without
 * the empty piece after a final `\n`. An empty text has no lines. */
function splitLinesAtLf(text: string): string[] {
  if (text === '') return [];
  const raw = text.split('\n');
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  return raw.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isBlankLine(l: string): boolean {
  return l.trim() === '';
}

/** Detect the format (SPEC section 4); null when no format is detected. */
function detectFormat(lines: string[]): string | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlankLine(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const m = /\S/.exec(lines[first]);
  if (m !== null && (m[0] === '[' || m[0] === '{')) return 'json';
  for (const l of lines) {
    if (l.replace(/[ \t]+$/, '') === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC section 6)                                      */
/* ------------------------------------------------------------------ */

interface UnifiedHunk {
  /** Old start, 1-based, from the `@@ -A ...` header. */
  a: number;
  items: BodyItem[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noBreakAfterLastCtxOrNew: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  noBreakAfterLastNew: boolean;
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: UnifiedHunk[];
}

/** The path of a `--- ` / `+++ ` header line: the text after the four
 * characters, up to the first tab, with surrounding spaces removed, with
 * one leading `a/` or `b/` removed; `/dev/null` means no file. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab !== -1) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse one hunk starting at `lines[i]`; returns the hunk and the index
 * of the first line after its body. */
function parseHunk(lines: string[], i: number): { hunk: UnifiedHunk; next: number } {
  const m = HUNK_RE.exec(lines[i]);
  if (m === null) throw new ParseFail(i + 1);
  const a = Number(m[1]);
  const items: BodyItem[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j];
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      items.push(bodyItem(l));
      j++;
    } else {
      break;
    }
  }
  // Empty lines at the end of a body are not part of it: drop trailing
  // items that came from raw empty lines.
  let drop = 0;
  {
    // items were pushed in order from lines[i+1 .. j-1]; the k-th item
    // from the end came from lines[j-1-k].
    let k = 0;
    while (k < items.length && lines[j - 1 - k] === '') k++;
    drop = k;
  }
  if (drop > 0) items.splice(items.length - drop, drop);
  let noBreakAfterLastCtxOrNew = false;
  let noBreakAfterLastNew = false;
  for (let k = items.length - 1; k >= 0; k--) {
    if (items[k].kind === 'ctx' || items[k].kind === 'new') {
      noBreakAfterLastCtxOrNew = k + 1 < items.length && items[k + 1].kind === 'mark';
      break;
    }
  }
  for (let k = items.length - 1; k >= 0; k--) {
    if (items[k].kind === 'new') {
      noBreakAfterLastNew = k + 1 < items.length && items[k + 1].kind === 'mark';
      break;
    }
  }
  return { hunk: { a, items, noBreakAfterLastCtxOrNew, noBreakAfterLastNew }, next: j };
}

/**
 * Parse a section's header and hunks starting at `lines[i]`; returns the
 * index of the first line of the next section (or the end of the patch).
 */
function parseSectionRest(lines: string[], i: number, sec: UnifiedSection): number {
  let inHeader = true;
  let pairSeen = false;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) return i;
    if (inHeader) {
      if (line.startsWith('--- ')) {
        if (i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
          sec.oldPath = headerPath(line);
          sec.newPath = headerPath(lines[i + 1]);
          pairSeen = true;
          i += 2;
          continue;
        }
        throw new ParseFail(i + 2);
      }
      if (line.startsWith('rename from ') && !pairSeen) {
        sec.oldPath = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ') && !pairSeen) {
        sec.newPath = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.create = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.del = true;
        i++;
        continue;
      }
      if (line.startsWith('@@')) {
        inHeader = false;
      } else {
        // index, old mode, new mode, similarity index, Index: and any
        // other header line are ignored.
        i++;
        continue;
      }
    }
    if (line.startsWith('@@')) {
      const { hunk, next } = parseHunk(lines, i);
      sec.hunks.push(hunk);
      i = next;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return i;
    // Outside bodies, lines that are not part of a section header are
    // ignored (prose, code fences).
    i++;
  }
  return i;
}

/** Parse the whole patch as a unified diff. */
function parseUnified(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new ParseFail(i + 1);
      const sec: UnifiedSection = { oldPath: m[1], newPath: m[2], create: false, del: false, hunks: [] };
      sections.push(sec);
      i = parseSectionRest(lines, i + 1, sec);
    } else if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      const sec: UnifiedSection = { oldPath: null, newPath: null, create: false, del: false, hunks: [] };
      sections.push(sec);
      i = parseSectionRest(lines, i, sec);
    } else if (line.startsWith('@@')) {
      throw new ParseFail(i + 1);
    } else {
      i++;
    }
  }
  if (sections.length === 0) throw new ParseFail(1);
  return sections;
}

/** Apply a section's hunks in order to a Doc's lines; returns the new Doc.
 * `strict` matches lines exactly (tier 0 only). */
function applyHunks(doc: Doc, hunks: UnifiedHunk[], failPath: string, strict: boolean): Doc {
  let lines = [...doc.lines];
  let eol = doc.eol;
  let d = 0;
  for (const h of hunks) {
    const oItems = h.items.filter((it) => it.kind !== 'new' && it.kind !== 'mark');
    const O = oItems.map((it) => it.text);
    const newCount = h.items.filter((it) => it.kind === 'new').length;
    const oldCount = h.items.filter((it) => it.kind === 'old').length;
    if (O.length > 0) {
      const found = strict
        ? (() => {
            const occ = occurrencesAt(lines, O, 0);
            return occ.length > 0 ? { tier: 0, occ } : null;
          })()
        : findTier(lines, O);
      if (found === null) throw new Fail('no-match', failPath);
      const target = h.a - 1 + d;
      let best = found.occ[0];
      for (const pos of found.occ) {
        if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
      }
      const runsToEnd = best + O.length === lines.length;
      lines = applyItems(lines, h.items, best, found.tier);
      if (runsToEnd) eol = !h.noBreakAfterLastCtxOrNew;
    } else {
      const N = h.items.filter((it) => it.kind === 'new').map((it) => it.text);
      const idx = Math.max(0, Math.min(h.a + d, lines.length));
      lines = [...lines.slice(0, idx), ...N, ...lines.slice(idx)];
      if (idx === lines.length) eol = !h.noBreakAfterLastCtxOrNew;
    }
    d += newCount - oldCount;
  }
  return { lines, brk: doc.brk, eol };
}

/** Apply one unified section to the tree. */
function applyUnifiedSection(tree: Tree, sec: UnifiedSection, moves: Array<[string, string]>, strict: boolean): void {
  const oldPath = sec.oldPath;
  const newPath = sec.newPath;
  if (oldPath !== null) checkSafe(oldPath);
  if (newPath !== null) checkSafe(newPath);
  const isCreate = sec.create || oldPath === null;
  const isDelete = sec.del || newPath === null;
  if (isCreate && newPath !== null) {
    if (tree.has(newPath)) throw new Fail('exists', newPath);
    const plusLines: string[] = [];
    for (const h of sec.hunks) {
      for (const it of h.items) if (it.kind === 'new') plusLines.push(it.text);
    }
    let noBreak = false;
    for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
      if (sec.hunks[hi].items.some((it) => it.kind === 'new')) {
        noBreak = sec.hunks[hi].noBreakAfterLastNew;
        break;
      }
    }
    tree.set(newPath, { lines: plusLines, brk: '\n', eol: plusLines.length > 0 ? !noBreak : false });
    return;
  }
  if (isDelete && oldPath !== null) {
    if (!tree.has(oldPath)) throw new Fail('missing', oldPath);
    tree.delete(oldPath);
    return;
  }
  if (oldPath === null || newPath === null) return;
  if (oldPath !== newPath) {
    if (!tree.has(oldPath)) throw new Fail('missing', oldPath);
    if (tree.has(newPath)) throw new Fail('exists', newPath);
    const doc = applyHunks(tree.get(oldPath) as Doc, sec.hunks, oldPath, strict);
    tree.delete(oldPath);
    tree.set(newPath, doc);
    moves.push([oldPath, newPath]);
    return;
  }
  if (!tree.has(oldPath)) throw new Fail('missing', oldPath);
  tree.set(oldPath, applyHunks(tree.get(oldPath) as Doc, sec.hunks, oldPath, strict));
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC section 7)                              */
/* ------------------------------------------------------------------ */

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function srMarker(l: string, marker: string): boolean {
  return l.replace(/[ \t]+$/, '') === marker;
}

/** Parse the whole patch as SEARCH/REPLACE blocks. */
function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  let prevEnd = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (srMarker(lines[i], '<<<<<<< SEARCH')) {
      const searchIdx = i;
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (srMarker(lines[j], '=======')) {
          eq = j;
          break;
        }
        if (srMarker(lines[j], '>>>>>>> REPLACE')) break;
      }
      if (eq === -1) throw new ParseFail(searchIdx + 1);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (srMarker(lines[j], '>>>>>>> REPLACE')) {
          rep = j;
          break;
        }
      }
      if (rep === -1) throw new ParseFail(searchIdx + 1);
      // The path is the nearest line before the SEARCH line, after the
      // previous block's REPLACE line, that is not blank and does not
      // start with three backticks (after trimming).
      let path: string | null = null;
      for (let j = searchIdx - 1; j > prevEnd; j--) {
        const t = lines[j].trim();
        if (t === '' || t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath === null) throw new ParseFail(searchIdx + 1);
        path = prevPath;
      }
      blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
      prevPath = path;
      prevEnd = rep;
      i = rep + 1;
    } else {
      i++;
    }
  }
  if (blocks.length === 0) throw new ParseFail(1);
  return blocks;
}

/** Apply one SEARCH/REPLACE block to the tree. */
function applySRBlock(tree: Tree, b: SRBlock, strict: boolean): void {
  checkSafe(b.path);
  if (b.oldLines.length === 0) {
    if (tree.has(b.path)) throw new Fail('exists', b.path);
    tree.set(b.path, { lines: [...b.newLines], brk: '\n', eol: b.newLines.length > 0 });
    return;
  }
  if (!tree.has(b.path)) throw new Fail('missing', b.path);
  const doc = tree.get(b.path) as Doc;
  const found = strict
    ? (() => {
        const occ = occurrencesAt(doc.lines, b.oldLines, 0);
        return occ.length > 0 ? { tier: 0, occ } : null;
      })()
    : findTier(doc.lines, b.oldLines);
  if (found === null) throw new Fail('no-match', b.path);
  if (found.occ.length > 1) throw new Fail('ambiguous', b.path);
  const items: BodyItem[] = [
    ...b.oldLines.map((t): BodyItem => ({ kind: 'old', text: t })),
    ...b.newLines.map((t): BodyItem => ({ kind: 'new', text: t })),
  ];
  tree.set(b.path, { ...doc, lines: applyItems(doc.lines, items, found.occ[0], found.tier) });
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC section 8)                                        */
/* ------------------------------------------------------------------ */

interface V4AChunk {
  anchor: string | null;
  items: BodyItem[];
  eof: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4AChunk[];
}

const V4A_ADD = '*** Add File: ';
const V4A_DEL = '*** Delete File: ';
const V4A_UPD = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';

function v4aSectionStart(line: string): 'add' | 'delete' | 'update' | null {
  if (line.startsWith(V4A_ADD)) return 'add';
  if (line.startsWith(V4A_DEL)) return 'delete';
  if (line.startsWith(V4A_UPD)) return 'update';
  return null;
}

/** Parse the whole patch as a V4A patch. */
function parseV4A(lines: string[]): V4ASection[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlankLine(lines[i])) {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) throw new ParseFail(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseFail(first + 1);
  if (lines[last].trim() !== '*** End Patch') throw new ParseFail(lines.length + 1);
  const sections: V4ASection[] = [];
  let i = first + 1;
  const end = last;
  while (i < end) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const kind = v4aSectionStart(line);
    if (kind === null) throw new ParseFail(i + 1);
    const prefix = kind === 'add' ? V4A_ADD : kind === 'delete' ? V4A_DEL : V4A_UPD;
    const path = line.slice(prefix.length).trim();
    // The section's lines run to the next section start or `*** End Patch`.
    let j = i + 1;
    const raw: string[] = [];
    while (j < end) {
      if (v4aSectionStart(lines[j]) !== null) break;
      raw.push(lines[j]);
      j++;
    }
    // Blank lines at the end of a section are not part of it.
    while (raw.length > 0 && isBlankLine(raw[raw.length - 1])) raw.pop();
    const lineNo = (k: number): number => i + 1 + k + 1;
    if (kind === 'add') {
      const addLines: string[] = [];
      for (let k = 0; k < raw.length; k++) {
        const l = raw[k];
        if (l === '') addLines.push('');
        else if (l[0] === '+') addLines.push(l.slice(1));
        else throw new ParseFail(lineNo(k));
      }
      sections.push({ kind, path, moveTo: null, addLines, chunks: [] });
    } else if (kind === 'delete') {
      for (let k = 0; k < raw.length; k++) {
        if (!isBlankLine(raw[k])) throw new ParseFail(lineNo(k));
      }
      sections.push({ kind, path, moveTo: null, addLines: [], chunks: [] });
    } else {
      let k = 0;
      let moveTo: string | null = null;
      if (raw.length > 0 && raw[0].startsWith(V4A_MOVE)) {
        moveTo = raw[0].slice(V4A_MOVE.length).trim();
        k = 1;
      }
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      let closedByEof = false;
      while (k < raw.length) {
        const l = raw[k];
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, items: [], eof: false };
          chunks.push(cur);
          closedByEof = false;
          k++;
        } else if (l === '*** End of File') {
          if (cur === null || closedByEof) throw new ParseFail(lineNo(k));
          cur.eof = true;
          closedByEof = true;
          k++;
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (closedByEof) throw new ParseFail(lineNo(k));
          if (cur === null) {
            cur = { anchor: null, items: [], eof: false };
            chunks.push(cur);
          }
          cur.items.push(bodyItem(l));
          k++;
        } else {
          throw new ParseFail(lineNo(k));
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseFail(i + 1);
      sections.push({ kind, path, moveTo, addLines: [], chunks });
    }
    i = j;
  }
  if (sections.length === 0) throw new ParseFail(1);
  return sections;
}

/** Apply one V4A section to the tree. */
function applyV4ASection(tree: Tree, sec: V4ASection, moves: Array<[string, string]>, strict: boolean): void {
  checkSafe(sec.path);
  if (sec.moveTo !== null) checkSafe(sec.moveTo);
  if (sec.kind === 'add') {
    if (tree.has(sec.path)) throw new Fail('exists', sec.path);
    tree.set(sec.path, { lines: [...sec.addLines], brk: '\n', eol: sec.addLines.length > 0 });
    return;
  }
  if (sec.kind === 'delete') {
    if (!tree.has(sec.path)) throw new Fail('missing', sec.path);
    tree.delete(sec.path);
    return;
  }
  if (!tree.has(sec.path)) throw new Fail('missing', sec.path);
  if (sec.moveTo !== null && tree.has(sec.moveTo)) throw new Fail('exists', sec.moveTo);
  const doc = tree.get(sec.path) as Doc;
  let lines = [...doc.lines];
  let cursor = 0;
  for (const ch of sec.chunks) {
    if (ch.anchor !== null) {
      let at: number | null = null;
      if (strict) {
        for (let x = cursor; x < lines.length; x++) {
          if (lines[x] === ch.anchor) {
            at = x;
            break;
          }
        }
      } else {
        at = findTierSingle(lines, ch.anchor, cursor);
      }
      if (at === null) throw new Fail('no-match', sec.path);
      cursor = at + 1;
    }
    const oItems = ch.items.filter((it) => it.kind !== 'new' && it.kind !== 'mark');
    const O = oItems.map((it) => it.text);
    if (O.length > 0) {
      const found = strict
        ? (() => {
            const occ = occurrencesAt(lines, O, 0, cursor);
            return occ.length > 0 ? { tier: 0, occ } : null;
          })()
        : findTier(lines, O, cursor);
      if (found === null) throw new Fail('no-match', sec.path);
      let pos: number;
      if (ch.eof) {
        const hit = found.occ.find((p) => p + O.length === lines.length);
        if (hit === undefined) throw new Fail('no-match', sec.path);
        pos = hit;
      } else {
        pos = found.occ[0];
      }
      lines = applyItems(lines, ch.items, pos, found.tier);
      const nCount = ch.items.filter((it) => it.kind === 'ctx' || it.kind === 'new').length;
      cursor = pos + nCount;
    } else {
      const N = ch.items.filter((it) => it.kind === 'new').map((it) => it.text);
      const idx = ch.eof ? lines.length : cursor;
      lines = [...lines.slice(0, idx), ...N, ...lines.slice(idx)];
      cursor = idx + N.length;
    }
  }
  const newDoc: Doc = { lines, brk: doc.brk, eol: doc.eol };
  if (sec.moveTo !== null) {
    tree.delete(sec.path);
    tree.set(sec.moveTo, newDoc);
    moves.push([sec.path, sec.moveTo]);
  } else {
    tree.set(sec.path, newDoc);
  }
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC section 9)                                         */
/* ------------------------------------------------------------------ */

type JsonEdit =
  | { kind: 'create'; path: string; fileText: string }
  | { kind: 'str_replace'; path: string; oldStr: string; newStr: string }
  | { kind: 'insert'; path: string; insertLine: number; newStr: string };

/** Validate one edit object; any fault is a parse error at `lineNo`. */
function toJsonEdit(v: unknown, lineNo: number): JsonEdit {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ParseFail(lineNo);
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') throw new ParseFail(lineNo);
  if (typeof o.command !== 'string') throw new ParseFail(lineNo);
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throw new ParseFail(lineNo);
    return { kind: 'create', path: o.path, fileText: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') throw new ParseFail(lineNo);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw new ParseFail(lineNo);
    return { kind: 'str_replace', path: o.path, oldStr: o.old_str, newStr: typeof o.new_str === 'string' ? o.new_str : '' };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) throw new ParseFail(lineNo);
    if (typeof o.new_str !== 'string') throw new ParseFail(lineNo);
    return { kind: 'insert', path: o.path, insertLine: o.insert_line, newStr: o.new_str };
  }
  throw new ParseFail(lineNo);
}

/** Parse the whole patch as JSON edits (one array, or JSON Lines). */
function parseJson(lines: string[], text: string): JsonEdit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlankLine(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseFail(1);
  if (lines[first].trimStart().startsWith('[')) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ParseFail(first + 1);
    }
    if (!Array.isArray(value) || value.length === 0) throw new ParseFail(first + 1);
    return value.map((v) => toJsonEdit(v, first + 1));
  }
  const edits: JsonEdit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isBlankLine(lines[i])) continue;
    let v: unknown;
    try {
      v = JSON.parse(lines[i]);
    } catch {
      throw new ParseFail(i + 1);
    }
    edits.push(toJsonEdit(v, i + 1));
  }
  if (edits.length === 0) throw new ParseFail(1);
  return edits;
}

/** Apply one JSON edit to the tree. */
function applyJsonEdit(tree: Tree, e: JsonEdit): void {
  checkSafe(e.path);
  if (e.kind === 'create') {
    if (tree.has(e.path)) throw new Fail('exists', e.path);
    tree.set(e.path, parseDoc(e.fileText));
    return;
  }
  if (!tree.has(e.path)) throw new Fail('missing', e.path);
  const doc = tree.get(e.path) as Doc;
  if (e.kind === 'str_replace') {
    let text = serializeDoc(doc);
    let oldStr = e.oldStr;
    let newStr = e.newStr;
    if (doc.brk === '\r\n') {
      text = text.replace(/\r\n/g, '\n');
      oldStr = oldStr.replace(/\r\n/g, '\n');
      newStr = newStr.replace(/\r\n/g, '\n');
    }
    let count = 0;
    let firstAt = -1;
    let idx = 0;
    for (;;) {
      const at = text.indexOf(oldStr, idx);
      if (at === -1) break;
      if (firstAt === -1) firstAt = at;
      count++;
      idx = at + 1;
    }
    if (count === 0) throw new Fail('no-match', e.path);
    if (count > 1) throw new Fail('ambiguous', e.path);
    const result = text.slice(0, firstAt) + newStr + text.slice(firstAt + oldStr.length);
    tree.set(e.path, parseDoc(doc.brk === '\r\n' ? result.replace(/\n/g, '\r\n') : result));
    return;
  }
  const nLines = doc.lines.length;
  if (e.insertLine < 0 || e.insertLine > nLines) throw new Fail('no-match', e.path);
  const ins = splitLinesAtLf(e.newStr);
  tree.set(e.path, {
    lines: [...doc.lines.slice(0, e.insertLine), ...ins, ...doc.lines.slice(e.insertLine)],
    brk: doc.brk,
    eol: doc.eol,
  });
}

/* ------------------------------------------------------------------ */
/* Driver (SPEC sections 2 and 10)                                     */
/* ------------------------------------------------------------------ */

type EditFn = (tree: Tree, moves: Array<[string, string]>) => void;

interface Row {
  key: string;
  text: string;
}

async function main(): Promise<void> {
  if (process.env.MAKEFUN_ENV_URL !== undefined && process.env.MAKEFUN_ENV_URL !== '') {
    const { runTrial } = await import('./runner.ts');
    await runTrial(process.env.MAKEFUN_ENV_URL);
    return;
  }
  const opts = parseArgs(process.argv.slice(2));
  if (opts === null) {
    process.stdout.write('error: usage\n');
    process.exitCode = 2;
    return;
  }
  const text = readPatch(opts.patch);
  if (text === null) {
    process.stdout.write('error: no-patch\n');
    process.exitCode = 2;
    return;
  }
  const lines = splitLinesAtLf(text);
  let format = opts.format;
  if (format === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) {
      process.stdout.write('error: format\n');
      process.exitCode = 2;
      return;
    }
    format = detected;
  }
  let edits: EditFn[];
  try {
    if (format === 'unified') {
      const secs = parseUnified(lines);
      edits = secs.map((sec) => (tree: Tree, moves: Array<[string, string]>) => applyUnifiedSection(tree, sec, moves, opts.strict));
    } else if (format === 'search-replace') {
      const blocks = parseSearchReplace(lines);
      edits = blocks.map((b) => (tree: Tree) => applySRBlock(tree, b, opts.strict));
    } else if (format === 'v4a') {
      const secs = parseV4A(lines);
      edits = secs.map((sec) => (tree: Tree, moves: Array<[string, string]>) => applyV4ASection(tree, sec, moves, opts.strict));
    } else {
      const jedits = parseJson(lines, text);
      edits = jedits.map((e) => (tree: Tree) => applyJsonEdit(tree, e));
    }
  } catch (err) {
    if (err instanceof ParseFail) {
      process.stdout.write(`error: parse ${err.line}\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
  const n = edits.length;
  const initial = readTree(process.cwd());
  const tree: Tree = new Map();
  for (const [p, t] of initial) tree.set(p, parseDoc(t));
  const moves: Array<[string, string]> = [];
  const failures: Fail[] = [];
  for (const edit of edits) {
    const snap = cloneTree(tree);
    try {
      edit(tree, moves);
    } catch (err) {
      if (err instanceof Fail) {
        tree.clear();
        for (const [k, v] of snap) tree.set(k, v);
        failures.push(err);
      } else {
        throw err;
      }
    }
  }
  if (failures.length > 0) {
    let out = '';
    for (const f of failures) out += `error: ${f.code} ${f.path}\n`;
    out += `failed: ${failures.length} of ${n} edits\n`;
    process.stdout.write(out);
    process.exitCode = 1;
    return;
  }
  const rows: Row[] = [];
  const deleted = new Set<string>();
  const added = new Set<string>();
  for (const p of initial.keys()) {
    if (!tree.has(p)) deleted.add(p);
    else if (serializeDoc(tree.get(p) as Doc) !== initial.get(p)) rows.push({ key: p, text: `M ${p}` });
  }
  for (const p of tree.keys()) {
    if (!initial.has(p)) added.add(p);
  }
  for (const [o, nw] of moves) {
    if (deleted.has(o) && added.has(nw)) {
      deleted.delete(o);
      added.delete(nw);
      rows.push({ key: nw, text: `R ${o} -> ${nw}` });
    }
  }
  for (const p of deleted) rows.push({ key: p, text: `D ${p}` });
  for (const p of added) rows.push({ key: p, text: `A ${p}` });
  rows.sort((a, b) => byteCompare(a.key, b.key));
  let out = '';
  for (const r of rows) out += `${r.text}\n`;
  out += rows.length === 1 ? 'ok: 1 file\n' : `ok: ${rows.length} files\n`;
  process.stdout.write(out);
  if (!opts.check) writeTree(initial, tree);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
