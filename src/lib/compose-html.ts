// Build the initial HTML body for a new compose / reply / forward, mirroring
// what the webmail composer (`components/email/email-composer.tsx`) produces.
// All values are HTML-escaped before insertion into the document.

import { escapeHtml, stripDangerousTags } from './email-html';

export interface ReplyMeta {
  from?: { email?: string; name?: string };
  to?: Array<{ email?: string; name?: string }>;
  cc?: Array<{ email?: string; name?: string }>;
  subject?: string;
  body?: string; // plain-text body (preferred when htmlBody absent)
  htmlBody?: string;
  receivedAt?: string;
}

function escapeForHtmlBody(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

function senderLabel(from?: { email?: string; name?: string }): string {
  if (!from) return '';
  if (from.name && from.email) return `${from.name} <${from.email}>`;
  return from.name || from.email || '';
}

function formatDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

/**
 * Build the seed HTML for a new compose / reply / forward. Returns an empty
 * paragraph for plain compose (so the contenteditable has a caret target).
 */
export function buildInitialHtml(
  mode: 'compose' | 'reply' | 'replyAll' | 'forward',
  reply?: ReplyMeta | null,
): string {
  if (!reply || mode === 'compose') return '<p><br></p>';

  const date = formatDate(reply.receivedAt);
  const fromStr = senderLabel(reply.from) || 'Unknown';
  const subject = reply.subject ?? '';

  const quotedBody = reply.htmlBody
    ? stripDangerousTags(reply.htmlBody)
    : reply.body
      ? escapeForHtmlBody(reply.body)
      : '';

  if (!quotedBody) return '<p><br></p>';

  if (mode === 'forward') {
    return [
      '<p><br></p>',
      '<div>---------- Forwarded message ----------<br>',
      `From: ${escapeHtml(fromStr)}<br>`,
      date ? `Date: ${escapeHtml(date)}<br>` : '',
      subject ? `Subject: ${escapeHtml(subject)}<br>` : '',
      reply.to && reply.to.length
        ? `To: ${escapeHtml(reply.to.map(senderLabel).filter(Boolean).join(', '))}<br>`
        : '',
      '</div>',
      `<blockquote style="margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex">${quotedBody}</blockquote>`,
    ].join('');
  }

  // reply / replyAll
  return [
    '<p><br></p>',
    '<div>',
    `On ${escapeHtml(date || 'a previous date')}, ${escapeHtml(fromStr)} wrote:`,
    '</div>',
    `<blockquote style="margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex">${quotedBody}</blockquote>`,
  ].join('');
}

/**
 * Strip HTML tags and decode common entities for a plain-text fallback body.
 * Mirrors the webmail's `htmlToPlainText` (DOMParser-based) since we don't
 * have DOMParser in the RN runtime.
 */
export function htmlToPlainText(html: string): string {
  if (!html) return '';
  let s = html;
  // Treat block-level boundaries and <br> as newlines before stripping tags.
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // Paragraph-level closes get a blank line; list/heading/cell closes a single
  // newline so they stack tightly.
  s = s.replace(/<\/(p|div|blockquote|pre)>/gi, '\n\n');
  s = s.replace(/<\/(li|h[1-6]|tr)>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '• ');
  s = s.replace(/<[^>]+>/g, '');
  // Decode the most common entities; leave the rest as-is.
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  // Collapse runs of >2 newlines and trim trailing whitespace per line.
  s = s.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n');
  return s.trim();
}

/**
 * Walk the editor HTML, replacing `<img data-cid="X" ...>` with `<img src="cid:X">`
 * (and dropping the data-cid attribute). Returns the rewritten HTML and the
 * set of CIDs actually referenced so the sender can include exactly the
 * needed inline parts.
 */
export function rewriteInlineImages(html: string): { html: string; usedCids: string[] } {
  if (!html || !/data-cid=/i.test(html)) return { html, usedCids: [] };
  const used = new Set<string>();
  const out = html.replace(
    /<img\b([^>]*?)\sdata-cid=("([^"]*)"|'([^']*)')([^>]*)>/gi,
    (_full, before: string, _quoted: string, dq: string | undefined, sq: string | undefined, after: string) => {
      const cid = dq ?? sq ?? '';
      if (!cid) return _full;
      used.add(cid);
      // Drop any existing src= and replace with cid: form.
      const merged = (before + after)
        .replace(/\ssrc=("[^"]*"|'[^']*')/gi, '')
        .trim();
      const space = merged ? ' ' + merged : '';
      return `<img src="cid:${cid}"${space}>`;
    },
  );
  return { html: out, usedCids: Array.from(used) };
}
