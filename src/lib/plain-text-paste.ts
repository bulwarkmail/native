// Turns a pasted plain-text list into real list HTML for the composer.
// Port of webmail components/email/plain-text-paste.ts. Webmail parses in its
// ProseMirror `clipboardTextParser`; here the editor page hands a plain-text
// paste that has a list to RN (see the `paste` listener in editor-html.ts),
// which converts it with this module and sends the HTML back to insert.
//
// The text comes from the clipboard, so every text run is HTML-escaped.

import { escapeHtml } from './email-html';

/**
 * Longest paste converted. A larger one is left to the WebView's default
 * paste, so a huge clipboard never crosses the bridge twice.
 */
export const PLAIN_PASTE_MAX_CHARS = 256 * 1024;

/**
 * Deepest list nesting converted. Each level re-reads the lines under it, so
 * a staircase of ever deeper items costs depth x size; no real list nests
 * this deep, and a paste that does is pasted as text.
 */
export const PLAIN_PASTE_MAX_DEPTH = 16;

class TooDeep extends Error {}

type PlainBlock =
  | { type: 'line'; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: PlainBlock[][] };

interface ItemMarker {
  indent: number;
  ordered: boolean;
  start: number;
  content: string;
}

// "- ", "* ", "• ", "1. " or "1) " followed by the item text.
const ITEM_MARKER = /^([ \t]*)(?:[-*•]|(\d{1,3})[.)])[ \t]+(?=\S)/;

const isBlank = (line: string) => line.trim() === '';

function indentOf(line: string): number {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ' ') col += 1;
    else if (line[i] === '\t') col += 4;
    else break;
  }
  return col;
}

function dedent(line: string, columns: number): string {
  let i = 0;
  for (let col = 0; i < line.length && col < columns; i++) {
    if (line[i] === ' ') col += 1;
    else if (line[i] === '\t') col += 4;
    else break;
  }
  return line.slice(i);
}

function itemMarker(line: string): ItemMarker | null {
  const m = ITEM_MARKER.exec(line);
  if (!m) return null;
  return {
    indent: indentOf(m[1]),
    ordered: m[2] !== undefined,
    start: m[2] !== undefined ? Number(m[2]) : 1,
    content: line.slice(m[0].length),
  };
}

function parseLines(lines: string[], depth: number): PlainBlock[] {
  const blocks: PlainBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const marker = itemMarker(lines[i]);
    if (marker) {
      const items: PlainBlock[][] = [];
      i = parseList(lines, i, marker, items, depth + 1);
      blocks.push({ type: 'list', ordered: marker.ordered, start: marker.start, items });
    } else {
      blocks.push({ type: 'line', text: isBlank(lines[i]) ? '' : lines[i] });
      i++;
    }
  }
  return blocks;
}

/**
 * Reads the items of one list starting at `i` into `items` and returns the
 * index of the first line after it. An item takes the lines indented under
 * it (continuations and nested lists) and, like Markdown, unindented lines
 * that follow it directly, so hard-wrapped items stay whole. Blank lines
 * between items are dropped; blank lines after the list are left for the
 * caller.
 */
function parseList(lines: string[], i: number, first: ItemMarker, items: PlainBlock[][], depth: number): number {
  if (depth > PLAIN_PASTE_MAX_DEPTH) throw new TooDeep();
  let marker = first;
  for (;;) {
    const body: { text: string; indented: boolean }[] = [];
    let j = i + 1;
    let end = j;
    let lazy = true;
    while (j < lines.length) {
      const line = lines[j];
      if (isBlank(line)) {
        lazy = false;
        j++;
        continue;
      }
      const indented = indentOf(line) > marker.indent;
      if (!indented && !(lazy && !itemMarker(line))) break;
      for (let k = end; k < j; k++) body.push({ text: '', indented: false });
      body.push({ text: line, indented });
      end = ++j;
      lazy = true;
    }

    // A loop, not Math.min(...): a spread of a huge body overflows the stack.
    let shift = Infinity;
    for (const l of body) if (l.indented) shift = Math.min(shift, indentOf(l.text));
    const rest = body.map((l) => (l.indented ? dedent(l.text, shift) : l.text.trimStart()));
    items.push([{ type: 'line', text: marker.content }, ...parseLines(rest, depth)]);

    let next = end;
    while (next < lines.length && isBlank(lines[next])) next++;
    const sibling = next < lines.length ? itemMarker(lines[next]) : null;
    if (!sibling || sibling.ordered !== first.ordered || sibling.indent !== first.indent) return end;
    i = next;
    marker = sibling;
  }
}

/**
 * The lines of one item, joined with <br> rather than wrapped in <p> as
 * webmail does: in a contenteditable a <p> inside an <li> makes Enter split
 * the paragraph instead of starting the next item.
 */
function itemHtml(blocks: PlainBlock[]): string {
  let html = '';
  let prev: PlainBlock['type'] | null = null;
  for (const block of blocks) {
    if (block.type === 'list') html += listHtml(block);
    else html += (prev === 'line' ? '<br>' : '') + escapeHtml(block.text);
    prev = block.type;
  }
  return html;
}

function listHtml(block: Extract<PlainBlock, { type: 'list' }>): string {
  const open = block.ordered ? (block.start === 1 ? '<ol>' : `<ol start="${block.start}">`) : '<ul>';
  const items = block.items.map((item) => `<li>${itemHtml(item)}</li>`).join('');
  return `${open}${items}${block.ordered ? '</ol>' : '</ul>'}`;
}

/**
 * The HTML for pasting `text`, with its "- " / "1. " items as real lists and
 * every other line as a paragraph (a blank line an empty one), or null when
 * the text has no list or is too long or deep to convert: the caller then
 * pastes it as text.
 */
export function plainTextPasteHtml(text: string): string | null {
  if (!text || text.length > PLAIN_PASTE_MAX_CHARS) return null;
  let blocks: PlainBlock[];
  try {
    blocks = parseLines(text.split(/\r\n?|\n/), 0);
  } catch (e) {
    if (e instanceof TooDeep) return null;
    throw e;
  }
  if (!blocks.some((b) => b.type === 'list')) return null;
  return blocks
    .map((b) => (b.type === 'list' ? listHtml(b) : b.text ? `<p>${escapeHtml(b.text)}</p>` : '<p><br></p>'))
    .join('');
}
