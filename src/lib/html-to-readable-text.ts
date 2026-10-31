/**
 * HTML mail as plain text, for "Plain Text Only" reading and the reader's
 * per-message "Show as plain text" when a message has no text/plain part of
 * its own. Port of the webmail's lib/html-to-readable-text.ts.
 *
 * Layout tables become lines, headings and paragraphs keep a blank line
 * around them, list items get a bullet, images are replaced by their alt text
 * and a link keeps its target in brackets after its text, so nothing the
 * formatted mail offered is lost.
 *
 * The webmail walks a DOMParser tree; React Native has no DOM, so this walks
 * the tags in order with a stack of open elements and closes the elements an
 * HTML parser would close on its own (a paragraph before a block, a list item
 * before the next one, table cells and rows).
 */

import { decodeEntities } from './verification-code';

const BLOCK = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CENTER', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION',
  'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE',
  'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TFOOT', 'THEAD', 'TR', 'UL',
]);
/** Blocks that get a blank line before and after, not just a line break. */
const PARAGRAPH = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'TABLE', 'HR']);
const SKIP = new Set(['HEAD', 'STYLE', 'SCRIPT', 'TEMPLATE', 'NOSCRIPT', 'TITLE', 'META', 'LINK', 'SVG', 'OBJECT', 'IFRAME']);
/** Elements whose content is raw text up to their end tag. */
const RAW_TEXT = new Set(['SCRIPT', 'STYLE', 'TITLE', 'TEXTAREA', 'XMP', 'NOSCRIPT', 'IFRAME', 'NOEMBED', 'NOFRAMES']);
const VOID = new Set(['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR']);

/** Link targets worth writing out: web, mail and phone links. */
function shownHref(href: string | null): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (/^mailto:/i.test(trimmed)) return trimmed.slice(7).split('?')[0] || null;
  if (/^(https?:|tel:)/i.test(trimmed)) return trimmed;
  return null;
}

function normalize(text: string): string {
  return text.replace(/[ \t\f\v\r\n\xa0]+/g, ' ');
}

/** Same address once with and once without the scheme or a trailing slash. */
function sameTarget(text: string, href: string): boolean {
  const strip = (s: string) => s.trim().toLowerCase().replace(/^(https?:\/\/|mailto:|tel:)/, '').replace(/\/$/, '');
  return strip(text) === strip(href);
}

const TOKEN = /<!--[\s\S]*?(?:-->|$)|<![^>]*>?|<\?[^>]*>?|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parseAttrs(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  ATTR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR.exec(raw)) !== null) {
    const name = m[1].toLowerCase();
    if (!attrs.has(name)) attrs.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
  }
  return attrs;
}

interface Frame {
  tag: string;
  /** Inside a skipped or hidden element: nothing is written. */
  skip: boolean;
  pre: boolean;
  listDepth: number;
  /** out.length when the element opened, for a link's text. */
  start: number;
  href: string | null;
}

/** Open elements an element closes when it starts, as an HTML parser does. */
function closesOnOpen(open: string, tag: string): boolean {
  if (open === 'P') return BLOCK.has(tag);
  if (open === 'LI') return tag === 'LI';
  if (open === 'DT' || open === 'DD') return tag === 'DT' || tag === 'DD';
  if (open === 'TD' || open === 'TH') return tag === 'TD' || tag === 'TH' || tag === 'TR';
  if (open === 'TR') return tag === 'TR';
  return false;
}

/** Elements that stop the search for an element to close on open. */
const SCOPE = new Set(['UL', 'OL', 'TABLE', 'DL', 'BLOCKQUOTE', 'DIV', 'TD', 'TH']);

export function htmlToReadableText(html: string): string {
  if (!html) return '';
  const out: string[] = [];
  // Pending line breaks, so runs of empty blocks collapse to one blank line.
  let pendingBreaks = 0;
  let atLineStart = true;

  const breakLine = (count: number) => {
    if (out.length === 0) return;
    pendingBreaks = Math.max(pendingBreaks, count);
  };
  const write = (text: string) => {
    if (!text) return;
    if (pendingBreaks > 0) {
      out.push('\n'.repeat(pendingBreaks));
      pendingBreaks = 0;
      atLineStart = true;
    }
    if (atLineStart) text = text.replace(/^ +/, '');
    if (!text) return;
    out.push(text);
    atLineStart = text.endsWith('\n');
  };

  const stack: Frame[] = [];
  const top = (): Frame | undefined => stack[stack.length - 1];

  const close = (frame: Frame) => {
    if (frame.skip) return;
    const { tag } = frame;
    if (tag === 'A') {
      const text = out.slice(frame.start).join('').trim();
      if (frame.href && !sameTarget(text, frame.href)) write(text ? ` (${frame.href})` : frame.href);
    }
    if (BLOCK.has(tag)) {
      const gap = PARAGRAPH.has(tag) && !(tag === 'UL' || tag === 'OL') ? 2 : 1;
      breakLine(tag === 'LI' ? 1 : gap);
    }
  };

  const open = (tag: string, attrs: Map<string, string>) => {
    // Close what this element implicitly ends (a <p> before a block, the
    // previous <li>, table cells and rows).
    for (let i = stack.length - 1; i >= 0; i--) {
      const frameTag = stack[i].tag;
      if (closesOnOpen(frameTag, tag)) {
        while (stack.length > i) close(stack.pop()!);
        break;
      }
      if (SCOPE.has(frameTag)) break;
    }

    const parent = top();
    const inherited = parent?.skip ?? false;
    const hidden = attrs.has('hidden') || /display\s*:\s*none/i.test(attrs.get('style') ?? '');
    const skip = inherited || SKIP.has(tag) || hidden;
    const pre = parent?.pre ?? false;
    const listDepth = parent?.listDepth ?? 0;

    if (VOID.has(tag)) {
      if (skip) return;
      if (tag === 'BR') {
        out.push('\n');
        pendingBreaks = 0;
        atLineStart = true;
      } else if (tag === 'IMG' || (tag === 'INPUT' && attrs.get('type') === 'image')) {
        const alt = normalize(attrs.get('alt') ?? '').trim();
        if (alt) write(`[${alt}]`);
      } else if (tag === 'HR') {
        breakLine(2);
        write('---');
        breakLine(2);
      }
      return;
    }

    if (!skip) {
      const isBlock = BLOCK.has(tag);
      const gap = PARAGRAPH.has(tag) && !(tag === 'UL' || tag === 'OL') ? 2 : 1;
      if (isBlock) breakLine(listDepth > 0 && (tag === 'UL' || tag === 'OL') ? 1 : gap);
      if (tag === 'LI') write(`${'  '.repeat(Math.max(0, listDepth - 1))}• `);
      if (tag === 'TD' || tag === 'TH') {
        if (!atLineStart && pendingBreaks === 0) write(' ');
      }
      if (tag === 'BLOCKQUOTE') write('> ');
    }
    stack.push({
      tag,
      skip,
      pre: pre || tag === 'PRE',
      listDepth: tag === 'UL' || tag === 'OL' ? listDepth + 1 : listDepth,
      start: out.length,
      href: tag === 'A' ? shownHref(attrs.get('href') ?? null) : null,
    });
  };

  const end = (tag: string) => {
    let i = stack.length - 1;
    while (i >= 0 && stack[i].tag !== tag) i--;
    if (i < 0) return; // a stray end tag
    while (stack.length > i) close(stack.pop()!);
  };

  const text = (raw: string) => {
    const frame = top();
    if (frame?.skip || !raw) return;
    const value = decodeEntities(raw);
    write(frame?.pre ? value : normalize(value));
  };

  TOKEN.lastIndex = 0;
  let lower: string | undefined;
  let pos = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(html)) !== null) {
    if (m.index > pos) text(html.slice(pos, m.index));
    pos = TOKEN.lastIndex;
    if (m[2] === undefined) continue; // comment, doctype, processing instruction
    const tag = m[2].toUpperCase();
    if (m[1]) {
      end(tag);
      continue;
    }
    open(tag, parseAttrs(m[3]));
    const selfClosing = /\/\s*$/.test(m[3]);
    if (selfClosing && !VOID.has(tag)) end(tag);
    if (RAW_TEXT.has(tag) && !selfClosing) {
      // Raw text runs to the end tag: a "<" inside a script is not a tag.
      lower ??= html.toLowerCase();
      const endAt = lower.indexOf(`</${tag.toLowerCase()}`, pos);
      const stop = endAt < 0 ? html.length : endAt;
      if (!SKIP.has(tag)) text(html.slice(pos, stop));
      pos = stop;
      TOKEN.lastIndex = stop;
    }
  }
  if (pos < html.length) text(html.slice(pos));
  while (stack.length > 0) close(stack.pop()!);

  return out
    .join('')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The text the reader shows for a message read as plain text: its own
 * text/plain part when it has one, else its HTML turned into text (webmail
 * email-viewer.tsx, 1e929b0a9). Null when there is no HTML to replace: a
 * plain-text message reads as it is.
 */
export function plainTextReading(body: { html: string | null; text: string | null }): string | null {
  if (!body.html) return null;
  if (body.text?.trim()) return body.text;
  return htmlToReadableText(body.html);
}
