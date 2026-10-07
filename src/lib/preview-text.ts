import { singleLine } from './single-line';

// Port of the webmail's `cleanPreview` (lib/utils.ts). Every step is anchored
// at the start of the text and the style-sheet loop is capped, so a hostile
// preview costs a bounded number of linear passes.

// Marketing emails pad the preheader with whitespace, format chars (soft
// hyphens, zero-width chars, BOM, directional marks) and combining marks
// (e.g. U+034F) to push real content past the preview window.
const LEADING_INVISIBLE_RE = /^[\s\p{Cf}\p{Mn}]+/u;
// After stripping, a server-side truncation indicator like "..." may be all
// that's left. Treat that as no preview so callers can fall back.
const ONLY_PUNCTUATION_RE = /^[.…\s]+$/;

export function stripInvisibleLeading(text: string): string {
  const stripped = text.replace(LEADING_INVISIBLE_RE, '');
  if (ONLY_PUNCTUATION_RE.test(stripped)) return '';
  return stripped;
}

// A style sheet at the start of the text: an at-rule, or a selector opening a
// rule. Plain prose does not start like this - "@" or "#" followed by a word
// and then, before any sentence ends, a "{".
const DECLARATIONS_RE = /^\s*(?:[-\w]+\s*:|[.#@a-z*][^{}]*\{)/i;
// At-rule names are matched case-sensitively: style sheets write them in lower
// case, while "@Page ..." at the start of a preview is a mention. A selector's
// colon is a pseudo-class ("a:hover"), never followed by a space as in
// "Reminder: your appointment {date: ...}".
const AT_RULE_RE = /^@(?:media|font-face|import|supports|keyframes|charset|page)\b/;
const SELECTOR_RE = /^[.#]?[a-z*](?:[\w\-.#,>~+*\s[\]="']|:(?!\s))*\{/i;

/**
 * Drops a style sheet from the start of a text preview.
 *
 * Some servers build the preview from an HTML body without skipping its
 * <style> element, so a marketing mail's preview can begin with
 * "@media screen and (min-width:600px){.hide{display:none!important;..." and
 * never reach the text. Whole leading rules are removed; a preview that ends
 * inside one was nothing but CSS and becomes empty, so callers fall back to
 * their "no preview" text.
 */
export function stripLeadingCss(text: string): string {
  let rest = text.trimStart();
  for (let guard = 0; guard < 100 && (AT_RULE_RE.test(rest) || SELECTOR_RE.test(rest)); guard++) {
    const brace = rest.indexOf('{');
    const semicolon = rest.indexOf(';');
    // `@import url(...);` and `@charset "x";` end without a block.
    if (semicolon >= 0 && (brace < 0 || semicolon < brace) && /^@(?:import|charset)\b/.test(rest)) {
      rest = rest.slice(semicolon + 1).trimStart();
      continue;
    }
    // An at-rule word with no block after it ("@media team, ...", "@page 3 ...")
    // starts prose, not a style sheet.
    if (brace < 0) return rest;
    let depth = 0;
    let end = -1;
    for (let i = brace; i < rest.length; i++) {
      if (rest[i] === '{') depth++;
      else if (rest[i] === '}' && --depth === 0) { end = i; break; }
    }
    if (end < 0) return rest.startsWith('@') || DECLARATIONS_RE.test(rest.slice(brace + 1)) ? '' : rest;
    // A rule's block holds declarations ("color: red") or further rules; a
    // brace in prose ("at {time} tomorrow") holds neither and ends the strip.
    if (!rest.startsWith('@') && !DECLARATIONS_RE.test(rest.slice(brace + 1, end))) return rest;
    rest = rest.slice(end + 1).trimStart();
  }
  return rest;
}

/** A message preview ready to show: no leading padding, no leading style sheet. */
export function cleanPreview(text: string | null | undefined): string {
  return stripInvisibleLeading(stripLeadingCss(stripInvisibleLeading(text ?? '')));
}

/**
 * The preview as the list row, the widgets and the notifications show it:
 * cleaned, then folded onto one line. One helper, so they agree.
 */
export function previewLine(text: string | null | undefined): string {
  return singleLine(cleanPreview(text));
}
