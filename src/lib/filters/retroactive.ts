import type { EmailAddress } from '../../api/types';
import type { FilterAction, FilterCondition, FilterRule } from '../sieve/types';
import { unfoldHeader } from './quick-rules';

/**
 * Running a filter rule over mail that is already there. Sieve only sees new
 * mail, so this happens in the client: a JMAP query narrows the folder down,
 * and `ruleMatches` decides with the same semantics the generated Sieve has.
 * The JMAP text filters are full-text searches, fuzzier than Sieve in both
 * directions, so the query is only ever narrowed where it is sure to return
 * every message the rule matches.
 */

/** A message as the retroactive pass sees it. */
export interface RetroMessage {
  id: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  from?: EmailAddress[] | null;
  to?: EmailAddress[] | null;
  cc?: EmailAddress[] | null;
  /** Lower-cased header name → every occurrence, decoded and unfolded. */
  headers: Record<string, string[]>;
}

const ADDRESS_FIELDS = new Set<FilterCondition['field']>(['from', 'to', 'cc']);
const FIELD_HEADER: Record<string, string> = { from: 'From', to: 'To', cc: 'Cc', subject: 'Subject' };
const TEXT_COMPARATORS = new Set<FilterCondition['comparator']>([
  'contains', 'not_contains', 'is', 'not_is', 'starts_with', 'ends_with', 'matches', 'address_is', 'domain_is',
]);
/** Actions that change a message that is already delivered. */
const APPLIED_ACTIONS = new Set<FilterAction['type']>(['move', 'copy', 'mark_read', 'star', 'add_label']);
/** Actions that are no-ops afterwards; `stop` only ends the delivery-time run. */
const NEUTRAL_ACTIONS = new Set<FilterAction['type']>(['stop']);

export type RetroSupport =
  | { ok: true }
  /** A condition the client cannot evaluate like Sieve does (body, size, attachment). */
  | { ok: false; reason: 'condition' }
  /** An action that must never run on old mail (forward, reject, discard) or has no meaning there (keep). */
  | { ok: false; reason: 'action' };

/** A header condition the client can evaluate: which header it reads. */
function conditionHeader(condition: FilterCondition): string | null {
  if (condition.field === 'header') {
    const name = condition.headerName?.trim();
    // Anything that cannot be a header field name is not worth a JMAP property.
    return name && /^[\x21-\x39\x3b-\x7e]+$/.test(name) ? name : null;
  }
  return FIELD_HEADER[condition.field] ?? null;
}

function usesAddressTest(condition: FilterCondition): boolean {
  return (condition.comparator === 'address_is' || condition.comparator === 'domain_is')
    && ADDRESS_FIELDS.has(condition.field);
}

export function retroactiveSupport(rule: Pick<FilterRule, 'conditions' | 'actions'>): RetroSupport {
  if (rule.conditions.length === 0) return { ok: false, reason: 'condition' };
  let patternChars = 0;
  for (const condition of rule.conditions) {
    if (!TEXT_COMPARATORS.has(condition.comparator) || !conditionHeader(condition)) {
      return { ok: false, reason: 'condition' };
    }
    // Bounded cost: oversize rules are saved, but not applied to old mail.
    const values = Array.isArray(condition.value) ? condition.value : [condition.value];
    if (values.length > MAX_VALUES_PER_CONDITION) return { ok: false, reason: 'condition' };
    for (const value of values) {
      const length = typeof value === 'string' ? value.length : 0;
      if (length > MAX_VALUE_LENGTH) return { ok: false, reason: 'condition' };
      patternChars += length;
    }
    if (patternChars > MAX_RULE_PATTERN_CHARS) return { ok: false, reason: 'condition' };
  }
  if (!rule.actions.some(a => APPLIED_ACTIONS.has(a.type))) return { ok: false, reason: 'action' };
  for (const action of rule.actions) {
    if (!APPLIED_ACTIONS.has(action.type) && !NEUTRAL_ACTIONS.has(action.type)) return { ok: false, reason: 'action' };
    // A folder known only by its path cannot be addressed over JMAP.
    if ((action.type === 'move' || action.type === 'copy') && !action.mailboxId) return { ok: false, reason: 'action' };
    if (action.type === 'add_label' && !action.value) return { ok: false, reason: 'action' };
  }
  return { ok: true };
}

/** Sieve's default comparator, i;ascii-casemap, folds ASCII letters only. */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 32));
}

/** A rule value this long, or more values than this, or more pattern text in total, is not run on old mail. */
export const MAX_VALUE_LENGTH = 512;
export const MAX_VALUES_PER_CONDITION = 50;
export const MAX_RULE_PATTERN_CHARS = 8192;
/** A message whose compared header is longer than this is skipped, never cut. */
export const MAX_HEADER_LENGTH = 8192;
/** Compared characters one plan may spend before it gives up. */
export const MAX_PLAN_COMPARED_CHARS = 50_000_000;

/** The pass would cost too much to run; nothing was changed. */
export class RetroactiveTooComplexError extends Error {
  constructor() {
    super('The rule is too expensive to run on existing messages');
    this.name = 'RetroactiveTooComplexError';
  }
}

const STAR = -1;
const ANY = -2;

/** A glob split on unescaped `*`; each segment holds code points and ANY for `?`. */
interface CompiledGlob {
  segments: Array<{ tokens: number[]; literal: string | null }>;
}

/** RFC 5228 section 2.7.1 `:matches`: `*` any run, `?` one character, a backslash escapes. */
function compileGlob(pattern: string): CompiledGlob {
  const chars = Array.from(pattern);
  const parts: number[][] = [[]];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '\\' && i + 1 < chars.length) parts[parts.length - 1].push(chars[++i].codePointAt(0)!);
    else if (ch === '*') parts.push([]);
    else if (ch === '?') parts[parts.length - 1].push(ANY);
    else parts[parts.length - 1].push(ch.codePointAt(0)!);
  }
  return {
    segments: parts.map(tokens => ({
      tokens,
      literal: tokens.includes(ANY) ? null : String.fromCodePoint(...tokens),
    })),
  };
}

/** Match `tokens` at `i`; the index after the match, or -1. */
function matchForward(tokens: number[], text: string, from: number): number {
  let i = from;
  for (const token of tokens) {
    if (i >= text.length) return -1;
    const cp = text.codePointAt(i)!;
    if (token !== ANY && token !== cp) return -1;
    i += cp > 0xffff ? 2 : 1;
  }
  return i;
}

/** Match `tokens` ending at `end`; the index it starts at, or -1. */
function matchBackward(tokens: number[], text: string, end: number): number {
  let i = end;
  for (let t = tokens.length - 1; t >= 0; t--) {
    if (i <= 0) return -1;
    let cp = text.charCodeAt(i - 1);
    let width = 1;
    if (cp >= 0xdc00 && cp <= 0xdfff && i >= 2) {
      const high = text.charCodeAt(i - 2);
      if (high >= 0xd800 && high <= 0xdbff) {
        cp = text.codePointAt(i - 2)!;
        width = 2;
      }
    }
    if (tokens[t] !== ANY && tokens[t] !== cp) return -1;
    i -= width;
  }
  return i;
}

/**
 * Leftmost segment at or after `from`: the index after it, or -1. Leftmost
 * is right for globs: taking a segment earlier never leaves less room.
 */
function findSegment(segment: CompiledGlob['segments'][number], text: string, from: number): number {
  if (segment.literal !== null) {
    const at = text.indexOf(segment.literal, from);
    return at < 0 ? -1 : at + segment.literal.length;
  }
  for (let i = from; i < text.length; i += text.codePointAt(i)! > 0xffff ? 2 : 1) {
    const end = matchForward(segment.tokens, text, i);
    if (end >= 0) return end;
  }
  return -1;
}

function globMatches(glob: CompiledGlob, text: string): boolean {
  const { segments } = glob;
  const first = segments[0];
  const afterFirst = matchForward(first.tokens, text, 0);
  if (afterFirst < 0) return false;
  if (segments.length === 1) return afterFirst === text.length;
  let pos = afterFirst;
  for (let k = 1; k < segments.length - 1; k++) {
    if (segments[k].tokens.length === 0) continue;
    pos = findSegment(segments[k], text, pos);
    if (pos < 0) return false;
  }
  const last = segments[segments.length - 1];
  const start = matchBackward(last.tokens, text, text.length);
  return start >= pos;
}

/**
 * RFC 5228 `:matches` of `pattern` against `text`. A pattern is split on
 * `*` and its segments are placed left to right, so there is no backtracking
 * and no regex is built from the pattern.
 */
export function sieveMatches(pattern: string, text: string): boolean {
  return globMatches(compileGlob(pattern), text);
}

function valueList(value: string | string[]): string[] {
  return (Array.isArray(value) ? value : [value]).filter(v => typeof v === 'string' && v.length > 0);
}

/** A condition's casemapped values, and for glob comparators their compiled patterns. */
interface PreparedCondition {
  keys: string[];
  globs: CompiledGlob[];
}

function prepareCondition(condition: FilterCondition): PreparedCondition {
  const keys = valueList(condition.value).map(asciiLower);
  const globs = keys.map(k => {
    switch (condition.comparator) {
      case 'starts_with': return compileGlob(`${k}*`);
      case 'ends_with': return compileGlob(`*${k}`);
      case 'matches': return compileGlob(k);
      default: return null;
    }
  }).filter((g): g is CompiledGlob => g !== null);
  return { keys, globs };
}

/** Compiled once per rule; `planRetroactive` shares it across every message. */
export type PreparedRule = PreparedCondition[];

export function prepareRule(rule: Pick<FilterRule, 'conditions'>): PreparedRule {
  return rule.conditions.map(prepareCondition);
}

/** Running count of compared characters over one plan. */
interface Budget {
  used: number;
}

function textMatches(
  comparator: FilterCondition['comparator'],
  index: number,
  prepared: PreparedCondition,
  subject: string,
): boolean {
  const s = asciiLower(subject);
  switch (comparator) {
    case 'is':
    case 'not_is':
      return s === prepared.keys[index];
    case 'starts_with':
    case 'ends_with':
    case 'matches':
      return globMatches(prepared.globs[index], s);
    default:
      return s.includes(prepared.keys[index]);
  }
}

function conditionMatches(
  condition: FilterCondition,
  prepared: PreparedCondition,
  message: RetroMessage,
  budget?: Budget,
): boolean {
  const values = prepared.keys;
  if (values.length === 0) return false;

  if (usesAddressTest(condition)) {
    const addresses = (message[condition.field as 'from' | 'to' | 'cc'] ?? [])
      .map(a => (a.email ?? '').trim())
      .filter(Boolean);
    const parts = condition.comparator === 'domain_is'
      ? addresses.map(a => (a.includes('@') ? a.slice(a.lastIndexOf('@') + 1) : ''))
      : addresses;
    const wanted = new Set(values);
    return parts.some(p => wanted.has(asciiLower(p)));
  }

  const header = conditionHeader(condition);
  const occurrences = header ? message.headers[header.toLowerCase()] ?? [] : [];
  // The generator writes an address comparator on a non-address field as
  // `header :contains`, so read it the same way.
  const comparator = condition.comparator === 'address_is' || condition.comparator === 'domain_is'
    ? 'contains'
    : condition.comparator;
  let positive = false;
  for (const occurrence of occurrences) {
    for (let i = 0; i < values.length && !positive; i++) {
      if (budget) {
        budget.used += occurrence.length + 1;
        if (budget.used > MAX_PLAN_COMPARED_CHARS) throw new RetroactiveTooComplexError();
      }
      positive = textMatches(comparator, i, prepared, occurrence);
    }
    if (positive) break;
  }
  return comparator === 'not_contains' || comparator === 'not_is' ? !positive : positive;
}

/** Move/copy rules skip mail the server called spam unless they opt in (see the generator's spam guard). */
function skipsSpam(rule: FilterRule): boolean {
  return !rule.includeSpam && rule.actions.some(a => a.type === 'move' || a.type === 'copy');
}

/** A compared header occurrence too long to match safely: the message is left alone. */
function hasOversizeHeader(rule: FilterRule, message: RetroMessage): boolean {
  for (const condition of rule.conditions) {
    if (usesAddressTest(condition)) continue;
    const header = conditionHeader(condition);
    const occurrences = header ? message.headers[header.toLowerCase()] ?? [] : [];
    if (occurrences.some(o => o.length > MAX_HEADER_LENGTH)) return true;
  }
  return false;
}

/**
 * Whether the rule's Sieve would act on `message`. The spam guard reads the
 * server's spam verdict, which a delivered message only carries as the
 * `$junk` keyword, so that is what stands in for it here. A message with a
 * compared header over MAX_HEADER_LENGTH never matches. Pass `prepared`
 * (from `prepareRule`) when matching many messages.
 */
export function ruleMatches(
  rule: FilterRule,
  message: RetroMessage,
  prepared: PreparedRule = prepareRule(rule),
  budget?: Budget,
): boolean {
  if (rule.conditions.length === 0) return false;
  if (hasOversizeHeader(rule, message)) return false;
  const results = rule.conditions.map((c, i) => conditionMatches(c, prepared[i], message, budget));
  const matched = rule.matchType === 'any' ? results.some(Boolean) : results.every(Boolean);
  if (!matched) return false;
  return !(skipsSpam(rule) && message.keywords?.$junk);
}

/**
 * The JMAP filter for the rule's candidates in `mailboxId`: always a superset
 * of what the rule matches. Only exact-address and exact-domain conditions
 * narrow it. Substring and pattern conditions would need a full-text match,
 * which can miss what a Sieve substring finds, and the `header` filter finds
 * nothing at all on Stalwart 0.16 (not even a header every message has), so
 * header conditions are left to `ruleMatches`.
 */
export function retroQueryFilter(rule: FilterRule, mailboxId: string): Record<string, unknown> {
  const narrow = (condition: FilterCondition): Record<string, unknown> | null => {
    if (!usesAddressTest(condition)) return null;
    const values = valueList(condition.value);
    if (values.length === 0) return null;
    const each = values.map(v => ({ [condition.field]: v }));
    return each.length === 1 ? each[0] : { operator: 'OR', conditions: each };
  };

  const narrowed = rule.conditions.map(narrow);
  const inMailbox = { inMailbox: mailboxId };
  if (rule.matchType === 'any') {
    if (narrowed.some(n => n === null) || narrowed.length === 0) return inMailbox;
    const parts = narrowed as Record<string, unknown>[];
    return { operator: 'AND', conditions: [inMailbox, parts.length === 1 ? parts[0] : { operator: 'OR', conditions: parts }] };
  }
  const parts = narrowed.filter((n): n is Record<string, unknown> => n !== null);
  return parts.length === 0 ? inMailbox : { operator: 'AND', conditions: [inMailbox, ...parts] };
}

/** The Email properties `ruleMatches` needs for this rule. */
export function retroProperties(rule: FilterRule): string[] {
  const properties = new Set<string>(['mailboxIds', 'keywords']);
  for (const condition of rule.conditions) {
    if (usesAddressTest(condition)) {
      properties.add(condition.field);
    } else {
      const header = conditionHeader(condition);
      // The raw form backs up the text form, which Stalwart answers with null
      // for headers it parses as structured (List-Id).
      if (header) {
        properties.add(`header:${header}:asText:all`);
        properties.add(`header:${header}:all`);
      }
    }
  }
  return [...properties];
}

/** Turn an Email/get record with `retroProperties` into a RetroMessage. */
export function toRetroMessage(record: Record<string, unknown>): RetroMessage {
  const headers: Record<string, string[]> = {};
  const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : value == null ? [] : [value]);
  for (const [key, value] of Object.entries(record)) {
    const m = /^header:(.+):asText:all$/.exec(key);
    if (!m) continue;
    const raw = asList(record[`header:${m[1]}:all`]);
    headers[m[1].toLowerCase()] = asList(value)
      .map((text, i) => (typeof text === 'string' ? text : unfoldHeader(raw[i])))
      .filter((v): v is string => typeof v === 'string');
  }
  return {
    id: String(record.id),
    mailboxIds: (record.mailboxIds as Record<string, boolean> | undefined) ?? {},
    keywords: (record.keywords as Record<string, boolean> | undefined) ?? {},
    from: record.from as EmailAddress[] | null | undefined,
    to: record.to as EmailAddress[] | null | undefined,
    cc: record.cc as EmailAddress[] | null | undefined,
    headers,
  };
}

/** One bulk change of the pass, in the order Sieve would apply them. */
export type RetroStep =
  | { kind: 'mark_read'; ids: string[] }
  | { kind: 'keyword'; ids: string[]; keyword: string }
  | { kind: 'copy'; ids: string[]; mailboxId: string }
  | { kind: 'move'; ids: string[]; mailboxId: string };

export interface RetroPlan {
  /** Messages at least one step changes: the "N existing messages". */
  ids: string[];
  steps: RetroStep[];
}

/**
 * What the rule would change on `messages`. Flags come first, as in the
 * generated script; a message already in the target folder is not moved,
 * and a message the rule would not change is not counted. Forward, reject
 * and discard never make it into a plan.
 */
export function planRetroactive(rule: FilterRule, messages: RetroMessage[]): RetroPlan {
  if (!retroactiveSupport(rule).ok) return { ids: [], steps: [] };
  const prepared = prepareRule(rule);
  const budget: Budget = { used: 0 };
  const matched = messages.filter(m => ruleMatches(rule, m, prepared, budget));
  const changed = new Set<string>();
  const steps: RetroStep[] = [];
  const add = (step: RetroStep) => {
    if (step.ids.length === 0) return;
    steps.push(step);
    for (const id of step.ids) changed.add(id);
  };

  const flagActions = rule.actions.filter(a => a.type === 'mark_read' || a.type === 'star' || a.type === 'add_label');
  for (const action of flagActions) {
    if (action.type === 'mark_read') {
      add({ kind: 'mark_read', ids: matched.filter(m => !m.keywords.$seen).map(m => m.id) });
      continue;
    }
    const keyword = action.type === 'star' ? '$flagged' : `$label:${action.value}`;
    add({ kind: 'keyword', ids: matched.filter(m => !m.keywords[keyword]).map(m => m.id), keyword });
  }

  // Sieve files a message into every fileinto target and nowhere else. The
  // first move replaces the message's folders, so it runs before the copies,
  // and every further target (a second move, a copy) adds a folder.
  const fileActions = rule.actions.filter(a => (a.type === 'move' || a.type === 'copy') && a.mailboxId);
  const firstMove = fileActions.find(a => a.type === 'move');
  const notIn = (mailboxId: string) => matched.filter(m => !m.mailboxIds[mailboxId]).map(m => m.id);
  if (firstMove) add({ kind: 'move', ids: notIn(firstMove.mailboxId!), mailboxId: firstMove.mailboxId! });
  for (const action of fileActions) {
    if (action === firstMove) continue;
    const mailboxId = action.mailboxId!;
    add({ kind: 'copy', ids: notIn(mailboxId), mailboxId });
  }

  return { ids: [...changed], steps };
}
