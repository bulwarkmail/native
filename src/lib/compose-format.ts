// Lightweight markdown-style formatting for the native composer.
//
// The compose body is plain text the user types into a TextInput. The toolbar
// inserts markdown-like markers around the current selection (** for bold,
// _ for italic, "- " line prefix for lists). On send we render that text to
// HTML for `htmlBody` and keep the source as `textBody`.
//
// This is intentionally NOT a full markdown parser - it covers the formats
// the toolbar produces plus a few common conveniences (auto-link bare URLs,
// preserve line breaks, blockquote `> `).

import { escapeHtml } from './email-html';

const BOLD_RE = /\*\*([^*\n]+)\*\*/g;
const ITALIC_RE = /(^|[^*\w])_([^_\n]+)_(?=$|[^*\w])/g;
const CID_IMG_RE = /!\[([^\]]*)\]\(cid:([^)\s]+)\)/g;
// Combined matcher: either a markdown link `[label](url)` or a bare URL.
// Handling both in one pass means URLs inside a markdown link's parentheses
// don't get auto-linked a second time.
const LINK_OR_URL_RE =
  /\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)|(\bhttps?:\/\/[^\s<>()"']+)/gi;

function inlineFormat(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(CID_IMG_RE, (_m, alt: string, cid: string) =>
    `<img src="cid:${cid}" alt="${alt}" />`,
  );
  out = out.replace(LINK_OR_URL_RE, (full, label, mdUrl, bareUrl) => {
    if (label !== undefined && mdUrl) {
      return `<a href="${mdUrl}" rel="noopener noreferrer">${label}</a>`;
    }
    if (bareUrl) {
      return `<a href="${bareUrl}" rel="noopener noreferrer">${bareUrl}</a>`;
    }
    return full;
  });
  out = out.replace(BOLD_RE, '<b>$1</b>');
  out = out.replace(ITALIC_RE, '$1<i>$2</i>');
  return out;
}

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'quote'; lines: string[] };

export function markdownToHtml(source: string): string {
  if (!source) return '';
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push({ kind: 'p', lines: para });
      para = [];
    }
  };

  for (const raw of lines) {
    const line = raw;
    const trimmed = line.trim();

    if (trimmed === '') {
      flushPara();
      continue;
    }

    const ulMatch = /^[-*]\s+(.+)$/.exec(trimmed);
    if (ulMatch) {
      flushPara();
      const last = blocks[blocks.length - 1];
      if (last && last.kind === 'ul') last.items.push(ulMatch[1]);
      else blocks.push({ kind: 'ul', items: [ulMatch[1]] });
      continue;
    }

    const olMatch = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (olMatch) {
      flushPara();
      const last = blocks[blocks.length - 1];
      if (last && last.kind === 'ol') last.items.push(olMatch[1]);
      else blocks.push({ kind: 'ol', items: [olMatch[1]] });
      continue;
    }

    const quoteMatch = /^>\s?(.*)$/.exec(trimmed);
    if (quoteMatch) {
      flushPara();
      const last = blocks[blocks.length - 1];
      if (last && last.kind === 'quote') last.lines.push(quoteMatch[1]);
      else blocks.push({ kind: 'quote', lines: [quoteMatch[1]] });
      continue;
    }

    para.push(line);
  }
  flushPara();

  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === 'p') {
      out.push(`<p>${b.lines.map(inlineFormat).join('<br />')}</p>`);
    } else if (b.kind === 'ul') {
      out.push(`<ul>${b.items.map((i) => `<li>${inlineFormat(i)}</li>`).join('')}</ul>`);
    } else if (b.kind === 'ol') {
      out.push(`<ol>${b.items.map((i) => `<li>${inlineFormat(i)}</li>`).join('')}</ol>`);
    } else {
      out.push(`<blockquote>${b.lines.map(inlineFormat).join('<br />')}</blockquote>`);
    }
  }
  return out.join('\n');
}

// Wrap the current selection of `text` in `before`/`after`. If nothing is
// selected, insert the markers at the caret. Returns the new text plus the
// new selection range.
export function wrapSelection(
  text: string,
  selection: { start: number; end: number },
  before: string,
  after: string,
  placeholder = '',
): { text: string; selection: { start: number; end: number } } {
  const start = Math.min(selection.start, selection.end);
  const end = Math.max(selection.start, selection.end);
  const middle = text.slice(start, end) || placeholder;
  const next = `${text.slice(0, start)}${before}${middle}${after}${text.slice(end)}`;
  const cursorStart = start + before.length;
  const cursorEnd = cursorStart + middle.length;
  return {
    text: next,
    selection: { start: cursorStart, end: cursorEnd },
  };
}

// Add a line prefix (e.g. "- " or "> ") to the line(s) covered by selection.
// If a line already starts with the prefix, it's removed (toggle behavior).
export function toggleLinePrefix(
  text: string,
  selection: { start: number; end: number },
  prefix: string,
): { text: string; selection: { start: number; end: number } } {
  const start = Math.min(selection.start, selection.end);
  const end = Math.max(selection.start, selection.end);
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = text.indexOf('\n', end);
  if (lineEnd === -1) lineEnd = text.length;

  const block = text.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  const allHave = lines.every((l) => l.startsWith(prefix));
  const next = lines
    .map((l) => (allHave ? l.slice(prefix.length) : `${prefix}${l}`))
    .join('\n');
  const newText = `${text.slice(0, lineStart)}${next}${text.slice(lineEnd)}`;
  const delta = next.length - block.length;
  return {
    text: newText,
    selection: { start: lineStart, end: lineEnd + delta },
  };
}

// Format the quoted reply prefix the composer adds before the original body
// when sending a reply / forward. Used both for textBody and as input to the
// htmlBody renderer.
export function formatReplyQuote(
  body: string,
  meta: { senderName: string; date: Date },
): string {
  const date = meta.date.toLocaleDateString();
  const lines = body.split('\n').map((l) => `> ${l}`).join('\n');
  return `\n\n---\nOn ${date}, ${meta.senderName} wrote:\n${lines}`;
}
