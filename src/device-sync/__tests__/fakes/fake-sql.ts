/**
 * The small SQL subset the device sync engine may use in `ProviderQuery.where`
 * and op selections, evaluated over in-memory rows for the fake providers.
 * Keeping the engine to this subset keeps it portable to the real providers
 * (SQLite) and testable here:
 *
 *   expr    := or
 *   or      := and ('OR' and)*
 *   and     := not ('AND' not)*
 *   not     := 'NOT' not | primary
 *   primary := '(' expr ')'
 *            | column ('=' | '!=' | '<>' | '<' | '<=' | '>' | '>=') value
 *            | column 'IS' ['NOT'] 'NULL'
 *            | column ['NOT'] 'IN' '(' value (',' value)* ')'
 *            | column ['NOT'] 'LIKE' value
 *   value   := '?' | 'string' | number
 *
 * Comparisons follow SQLite closely enough: NULL compares false, numbers and
 * numeric strings compare as numbers (column affinity), LIKE is
 * case-insensitive with `%` and `_`.
 */
import type { Cell } from '../../types';

type Value = { kind: 'arg'; index: number } | { kind: 'lit'; value: string | number };

type Node =
  | { t: 'or'; parts: Node[] }
  | { t: 'and'; parts: Node[] }
  | { t: 'not'; inner: Node }
  | { t: 'cmp'; column: string; op: string; value: Value }
  | { t: 'isnull'; column: string; negate: boolean }
  | { t: 'in'; column: string; values: Value[]; negate: boolean }
  | { t: 'like'; column: string; value: Value; negate: boolean };

type Token = { k: 'id' | 'str' | 'num' | 'op' | 'arg' | 'lp' | 'rp' | 'comma'; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { out.push({ k: 'lp', v: c }); i++; continue; }
    if (c === ')') { out.push({ k: 'rp', v: c }); i++; continue; }
    if (c === ',') { out.push({ k: 'comma', v: c }); i++; continue; }
    if (c === '?') { out.push({ k: 'arg', v: c }); i++; continue; }
    if (c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") { s += "'"; j += 2; continue; }
        if (src[j] === "'") break;
        s += src[j++];
      }
      if (j >= src.length) throw new Error(`fake-sql: unterminated string in ${src}`);
      out.push({ k: 'str', v: s });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['!=', '<>', '<=', '>='].includes(two)) { out.push({ k: 'op', v: two }); i += 2; continue; }
    if (['=', '<', '>'].includes(c)) { out.push({ k: 'op', v: c }); i++; continue; }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num) { out.push({ k: 'num', v: num[0] }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) { out.push({ k: 'id', v: id[0] }); i += id[0].length; continue; }
    throw new Error(`fake-sql: unexpected '${c}' in ${src}`);
  }
  return out;
}

class Parser {
  private pos = 0;
  private argIndex = 0;
  constructor(private readonly tokens: Token[], private readonly src: string) {}

  parse(): Node {
    const node = this.or();
    if (this.pos !== this.tokens.length) this.fail('trailing input');
    return node;
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private kw(word: string): boolean {
    const t = this.peek();
    if (t?.k === 'id' && t.v.toUpperCase() === word) { this.pos++; return true; }
    return false;
  }
  private fail(msg: string): never { throw new Error(`fake-sql: ${msg} in "${this.src}"`); }

  private or(): Node {
    const parts = [this.and()];
    while (this.kw('OR')) parts.push(this.and());
    return parts.length === 1 ? parts[0] : { t: 'or', parts };
  }
  private and(): Node {
    const parts = [this.not()];
    while (this.kw('AND')) parts.push(this.not());
    return parts.length === 1 ? parts[0] : { t: 'and', parts };
  }
  private not(): Node {
    if (this.kw('NOT')) return { t: 'not', inner: this.not() };
    return this.primary();
  }
  private value(): Value {
    const t = this.tokens[this.pos++];
    if (!t) this.fail('missing value');
    if (t.k === 'arg') return { kind: 'arg', index: this.argIndex++ };
    if (t.k === 'str') return { kind: 'lit', value: t.v };
    if (t.k === 'num') return { kind: 'lit', value: Number(t.v) };
    return this.fail(`expected a value, got ${t.v}`);
  }
  private primary(): Node {
    const t = this.peek();
    if (!t) this.fail('unexpected end');
    if (t.k === 'lp') {
      this.pos++;
      const inner = this.or();
      if (this.peek()?.k !== 'rp') this.fail('missing )');
      this.pos++;
      return inner;
    }
    if (t.k !== 'id') this.fail(`expected a column, got ${t.v}`);
    this.pos++;
    const column = t.v;
    if (this.kw('IS')) {
      const negate = this.kw('NOT');
      if (!this.kw('NULL')) this.fail('expected NULL');
      return { t: 'isnull', column, negate };
    }
    const negate = this.kw('NOT');
    if (this.kw('IN')) {
      if (this.peek()?.k !== 'lp') this.fail('expected (');
      this.pos++;
      const values = [this.value()];
      while (this.peek()?.k === 'comma') { this.pos++; values.push(this.value()); }
      if (this.peek()?.k !== 'rp') this.fail('missing )');
      this.pos++;
      return { t: 'in', column, values, negate };
    }
    if (this.kw('LIKE')) return { t: 'like', column, value: this.value(), negate };
    if (negate) this.fail('NOT must precede IN or LIKE here');
    const op = this.tokens[this.pos++];
    if (op?.k !== 'op') this.fail(`expected an operator after ${column}`);
    return { t: 'cmp', column, op: op.v, value: this.value() };
  }
}

const cache = new Map<string, { node: Node; argCount: number }>();

function compile(where: string): { node: Node; argCount: number } {
  let hit = cache.get(where);
  if (!hit) {
    const tokens = tokenize(where);
    const node = new Parser(tokens, where).parse();
    hit = { node, argCount: tokens.filter((t) => t.k === 'arg').length };
    cache.set(where, hit);
  }
  return hit;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

/** SQLite-like comparison: -1/0/1, or null when either side is NULL. */
export function compareCells(a: Cell, b: Cell): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== null && nb !== null) return na === nb ? 0 : na < nb ? -1 : 1;
  const sa = String(a);
  const sb = String(b);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

function likeToRegex(pattern: string): RegExp {
  const esc = pattern.replace(/[.*+^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${esc}$`, 'is');
}

export type ColumnReader = (column: string) => Cell;

/** A predicate for rows, from a WHERE clause and its arguments. */
export function compileWhere(where: string | undefined, args: Array<string | number> = []): (read: ColumnReader) => boolean {
  if (!where || !where.trim()) return () => true;
  const { node, argCount } = compile(where);
  if (argCount !== args.length) {
    throw new Error(`fake-sql: "${where}" has ${argCount} placeholders but ${args.length} arguments`);
  }
  const val = (v: Value): Cell => (v.kind === 'arg' ? args[v.index] : v.value);
  const evalNode = (n: Node, read: ColumnReader): boolean => {
    switch (n.t) {
      case 'or': return n.parts.some((p) => evalNode(p, read));
      case 'and': return n.parts.every((p) => evalNode(p, read));
      case 'not': return !evalNode(n.inner, read);
      case 'isnull': {
        const isNull = read(n.column) === null || read(n.column) === undefined;
        return n.negate ? !isNull : isNull;
      }
      case 'in': {
        const cell = read(n.column);
        if (cell === null || cell === undefined) return false;
        const hit = n.values.some((v) => compareCells(cell, val(v)) === 0);
        return n.negate ? !hit : hit;
      }
      case 'like': {
        const cell = read(n.column);
        if (cell === null || cell === undefined) return false;
        const hit = likeToRegex(String(val(n.value))).test(String(cell));
        return n.negate ? !hit : hit;
      }
      case 'cmp': {
        const c = compareCells(read(n.column), val(n.value));
        if (c === null) return false;
        switch (n.op) {
          case '=': return c === 0;
          case '!=':
          case '<>': return c !== 0;
          case '<': return c < 0;
          case '<=': return c <= 0;
          case '>': return c > 0;
          case '>=': return c >= 0;
        }
        return false;
      }
    }
  };
  return (read) => evalNode(node, read);
}

/** Columns a WHERE clause mentions, so the fake can reject unknown ones like SQLite does. */
export function whereColumns(where: string | undefined): string[] {
  if (!where || !where.trim()) return [];
  const { node } = compile(where);
  const out: string[] = [];
  const walk = (n: Node): void => {
    switch (n.t) {
      case 'or':
      case 'and': n.parts.forEach(walk); break;
      case 'not': walk(n.inner); break;
      default: out.push(n.column);
    }
  };
  walk(node);
  return out;
}

/** A comparator for `orderBy` ("col [ASC|DESC], …"); `_id` ascending when absent. */
export function compileOrderBy(orderBy: string | undefined): (a: ColumnReader, b: ColumnReader) => number {
  const terms = (orderBy?.trim() ? orderBy.split(',') : ['_id'])
    .map((term) => term.trim().split(/\s+/))
    .map(([column, dir]) => ({ column, desc: dir?.toUpperCase() === 'DESC' }));
  return (a, b) => {
    for (const { column, desc } of terms) {
      const va = a(column);
      const vb = b(column);
      let c: number;
      if (va === null && vb === null) c = 0;
      else if (va === null) c = -1; // SQLite sorts NULL first
      else if (vb === null) c = 1;
      else c = compareCells(va, vb) ?? 0;
      if (c !== 0) return desc ? -c : c;
    }
    return 0;
  };
}
