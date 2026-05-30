// Build the initial HTML body for a new compose / reply / forward, mirroring
// what the webmail composer (`components/email/email-composer.tsx`) produces.
// All values are HTML-escaped before insertion into the document.

import { escapeHtml, stripDangerousTags } from './email-html';
import type { TimeFormat } from '../stores/settings-store';

export interface ReplyMeta {
  from?: { email?: string; name?: string };
  to?: Array<{ email?: string; name?: string }>;
  cc?: Array<{ email?: string; name?: string }>;
  subject?: string;
  body?: string; // plain-text body (preferred when htmlBody absent)
  htmlBody?: string;
  receivedAt?: string;
}

export interface QuoteHeaderOptions {
  timeFormat?: TimeFormat;
  locale?: string;
  unknownLabel?: string;
}

function escapeForHtmlBody(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

// Webmail's default quote header labels the sender by display name when there
// is one, falling back to the bare address — not "Name <addr>".
function senderName(from?: { email?: string; name?: string }, unknownLabel = 'Unknown'): string {
  if (!from) return unknownLabel;
  return from.name || from.email || unknownLabel;
}

// Mirror the webmail quote-header date: locale- and 12/24h-aware, with a short
// weekday (lib/quote-header.ts → formatDateTime with weekday/year/month/day).
function formatQuoteDate(iso: string | undefined, timeFormat: TimeFormat, locale?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const intlLocale = !locale || locale === 'en' ? 'en-US' : locale;
  return d.toLocaleString(intlLocale, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: timeFormat === '12h',
  });
}

const BLOCKQUOTE_STYLE = 'margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex';

/**
 * Build the seed HTML for a new compose / reply / forward. Returns an empty
 * paragraph for plain compose (so the contenteditable has a caret target).
 *
 * The reply/forward quote header mirrors the webmail default header
 * (`lib/quote-header.ts`): a reply gets "On <date>, <sender> wrote:" above a
 * blockquoted body; a forward gets a From/Date/Subject block followed by the
 * original body (not blockquoted).
 */
export function buildInitialHtml(
  mode: 'compose' | 'reply' | 'replyAll' | 'forward',
  reply?: ReplyMeta | null,
  opts: QuoteHeaderOptions = {},
): string {
  if (!reply || mode === 'compose') return '<p><br></p>';

  const { timeFormat = '24h', locale, unknownLabel = 'Unknown' } = opts;
  const date = formatQuoteDate(reply.receivedAt, timeFormat, locale);
  const fromStr = senderName(reply.from, unknownLabel);
  const subject = reply.subject ?? '';

  const quotedBody = reply.htmlBody
    ? stripDangerousTags(reply.htmlBody)
    : reply.body
      ? escapeForHtmlBody(reply.body)
      : '';

  if (!quotedBody) return '<p><br></p>';

  if (mode === 'forward') {
    // Forwarded message block (From/Date/Subject), body appended unquoted.
    return [
      '<p><br></p>',
      '<div>---------- Forwarded message ----------<br>',
      `From: ${escapeHtml(fromStr)}<br>`,
      `Date: ${escapeHtml(date)}<br>`,
      `Subject: ${escapeHtml(subject)}<br><br>`,
      '</div>',
      quotedBody,
    ].join('');
  }

  // reply / replyAll
  const headerLine = date
    ? `On ${escapeHtml(date)}, ${escapeHtml(fromStr)} wrote:`
    : `${escapeHtml(fromStr)} wrote:`;
  return [
    '<p><br></p>',
    `<div>${headerLine}<br></div>`,
    `<blockquote style="${BLOCKQUOTE_STYLE}">${quotedBody}</blockquote>`,
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
