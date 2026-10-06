/**
 * SearchSnippet/get support (RFC 8621 section 5).
 *
 * For each search hit the server returns the subject and a body excerpt with
 * the matching words wrapped in `<mark>` and the rest HTML-escaped. The text
 * is sender-controlled, so it is never rendered as HTML: it is cut into text
 * runs (plain or marked) and shown as <Text>. Parsing is a single linear
 * pass over at most 4 KB.
 */

export interface SnippetRun {
  text: string;
  marked: boolean;
}

/** A SearchSnippet object as returned by SearchSnippet/get. */
export interface SearchSnippetResult {
  emailId: string;
  subject?: string | null;
  preview?: string | null;
}

/** What a result row shows in place of its subject / preview; null = no highlight there. */
export interface RowSnippet {
  subject: SnippetRun[] | null;
  preview: SnippetRun[] | null;
}

/** Snippets of the search on screen, by `snippetKey(account, emailId)`. */
export type SnippetMap = Record<string, RowSnippet>;

/** Characters of a snippet that are looked at; the rest is ignored. */
export const MAX_SNIPPET_CHARS = 4096;

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
// Every quantifier is bounded, so a hostile run of '&' or digits stays linear.
const ENTITY_RE = /&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([a-z]{2,4}));/g;

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY_RE, (whole, hex?: string, dec?: string, name?: string) => {
    if (name) return NAMED[name] ?? whole;
    const code = hex ? parseInt(hex, 16) : parseInt(dec as string, 10);
    // Not a character: NUL, a surrogate half, or past U+10FFFF.
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
    return String.fromCodePoint(code);
  });
}

const OPEN = '<mark>';
const CLOSE = '</mark>';

/**
 * Cuts a snippet into plain and `<mark>`ed runs. Only `<mark>` and `</mark>`
 * are tags; anything else, `<script>` included, is literal text. Nested marks
 * count depth, a stray `</mark>` is ignored, and an unclosed `<mark>` marks to
 * the end.
 */
export function parseSearchSnippet(snippet: string | null | undefined): SnippetRun[] {
  if (typeof snippet !== 'string' || snippet.length === 0) return [];
  let input = snippet;
  if (input.length > MAX_SNIPPET_CHARS) {
    input = input.slice(0, MAX_SNIPPET_CHARS);
    // The cut may have split a surrogate pair or a tag; neither is shown.
    const last = input.charCodeAt(input.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) input = input.slice(0, -1);
    const lt = input.lastIndexOf('<');
    if (lt >= 0 && input.indexOf('>', lt) < 0) input = input.slice(0, lt);
  }

  const runs: SnippetRun[] = [];
  const push = (raw: string, marked: boolean) => {
    if (raw.length === 0) return;
    const text = decodeEntities(raw);
    const prev = runs[runs.length - 1];
    if (prev && prev.marked === marked) prev.text += text;
    else runs.push({ text, marked });
  };

  let depth = 0;
  let from = 0; // start of the text not yet pushed
  let scan = 0;
  while (scan < input.length) {
    const lt = input.indexOf('<', scan);
    if (lt < 0) break;
    if (input.startsWith(OPEN, lt)) {
      push(input.slice(from, lt), depth > 0);
      depth += 1;
      from = scan = lt + OPEN.length;
    } else if (input.startsWith(CLOSE, lt)) {
      push(input.slice(from, lt), depth > 0);
      if (depth > 0) depth -= 1;
      from = scan = lt + CLOSE.length;
    } else {
      scan = lt + 1;
    }
  }
  push(input.slice(from), depth > 0);
  return runs;
}

/** True when a run list carries at least one highlighted word. */
export function hasMarkedRun(runs: SnippetRun[]): boolean {
  return runs.some((r) => r.marked && r.text.length > 0);
}

const TERM_PROPERTIES = new Set(['text', 'subject', 'body']);

/**
 * Whether a JMAP Email filter has a word the server can highlight (`text`,
 * `subject` or `body`). Filters of only structural conditions (folder,
 * keywords, dates, addresses, size) produce empty snippets, so the extra
 * method call is left out for them.
 */
export function filterHasSnippetTerms(filter: Record<string, unknown> | undefined): boolean {
  if (!filter) return false;
  const conditions = filter.conditions;
  if (Array.isArray(conditions)) {
    return conditions.some((c) => !!c && typeof c === 'object' && filterHasSnippetTerms(c as Record<string, unknown>));
  }
  return Object.entries(filter).some(
    ([key, value]) => TERM_PROPERTIES.has(key) && typeof value === 'string' && value.trim().length > 0,
  );
}

/** The key of one message's snippet: ids repeat across accounts, so the account is part of it. */
export function snippetKey(accountId: string, emailId: string): string {
  return JSON.stringify([accountId, emailId]);
}

/**
 * Adds a SearchSnippet/get list for one account to `into`. A snippet with no
 * highlighted word (the server found nothing to mark) is left out, so the row
 * keeps its normal subject and preview.
 */
export function collectSnippets(
  into: SnippetMap,
  accountId: string,
  results: SearchSnippetResult[] | undefined,
): void {
  if (!Array.isArray(results)) return;
  for (const result of results) {
    if (!result || typeof result.emailId !== 'string') continue;
    const subject = parseSearchSnippet(result.subject);
    const preview = parseSearchSnippet(result.preview);
    const row: RowSnippet = {
      subject: hasMarkedRun(subject) ? subject : null,
      preview: hasMarkedRun(preview) ? preview : null,
    };
    if (row.subject || row.preview) into[snippetKey(accountId, result.emailId)] = row;
  }
}
