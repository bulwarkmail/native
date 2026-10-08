// Build the initial HTML body for a new compose / reply / forward, mirroring
// what the webmail composer (`components/email/email-composer.tsx`) produces.
// All values are HTML-escaped before insertion into the document.

import { escapeHtml, stripDangerousTags } from './email-html';
import { buildQuoteHeader, type QuoteHeaderLabels } from './quote-header';
import type { TimeFormat } from '../stores/settings-store';
import type { DateRegion } from './date-format';

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
  region?: DateRegion;
  unknownLabel?: string;
  labels?: QuoteHeaderLabels;
}

function escapeForHtmlBody(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

const BLOCKQUOTE_STYLE = 'margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex';

/**
 * Marker attribute on the wrapper that holds the quoted original (header +
 * body). The signature splice uses it to place the signature above the quote,
 * and the attachment reminder strips it before keyword matching (#570).
 */
export const QUOTED_BLOCK_ATTR = 'data-quoted-html';
export const QUOTED_BLOCK_START = `<div ${QUOTED_BLOCK_ATTR}="true">`;

/**
 * Build the seed HTML for a new compose / reply / forward. Returns an empty
 * paragraph for plain compose (so the contenteditable has a caret target).
 *
 * The reply/forward quote header mirrors the webmail default header
 * (`lib/quote-header.ts`): a reply gets "On <date>, <sender> wrote:" above a
 * blockquoted body; a forward gets a From/Date/Subject block followed by the
 * original body (not blockquoted). The quoted part is wrapped in a
 * `data-quoted-html` div.
 */
export function buildInitialHtml(
  mode: 'compose' | 'reply' | 'replyAll' | 'forward',
  reply?: ReplyMeta | null,
  opts: QuoteHeaderOptions = {},
): string {
  if (!reply || mode === 'compose') return '<p><br></p>';

  const { timeFormat = '24h', locale, region, unknownLabel = 'Unknown', labels } = opts;

  const quotedBody = reply.htmlBody
    ? stripDangerousTags(reply.htmlBody)
    : reply.body
      ? escapeForHtmlBody(reply.body)
      : '';

  if (!quotedBody) return '<p><br></p>';

  const header = buildQuoteHeader({
    mode,
    email: { from: reply.from, subject: reply.subject, receivedAt: reply.receivedAt },
    timeFormat,
    locale,
    region,
    unknownLabel,
    labels,
  });

  const quoted = header.wrapInBlockquote
    ? `${header.html}<blockquote style="${BLOCKQUOTE_STYLE}">${quotedBody}</blockquote>`
    : `${header.html}${quotedBody}`;

  return `<p><br></p>${QUOTED_BLOCK_START}${quoted}</div>`;
}

/**
 * Strip HTML tags and decode common entities for a plain-text fallback body.
 * Mirrors the webmail's `htmlToPlainText` (DOMParser-based) since we don't
 * have DOMParser in the RN runtime. Links keep their target as `text <href>`
 * so a pasted link survives the text/plain alternative.
 */
export function htmlToPlainText(html: string): string {
  if (!html) return '';
  let s = html;
  // Drop non-content blocks entirely.
  s = s.replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  // Links: "text <href>" unless the text already is the URL (or mailto target).
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_full, attrs: string, inner: string) => {
    const hrefMatch = attrs.match(/\shref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const href = (hrefMatch?.[2] ?? hrefMatch?.[3] ?? hrefMatch?.[4] ?? '').trim();
    const text = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!href) return inner;
    const normalizedHref = href.replace(/^mailto:/i, '');
    if (!text || text === href || text === normalizedHref) return text || href;
    // Angle brackets are restored after the tag strip below.
    return `${text} \u0001${href}\u0002`;
  });
  // Treat block-level boundaries and <br> as newlines before stripping tags.
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // Paragraph-level closes get a blank line; list/heading/cell closes a single
  // newline so they stack tightly.
  s = s.replace(/<\/(p|div|blockquote|pre)>/gi, '\n\n');
  s = s.replace(/<\/(li|h[1-6]|tr)>/gi, '\n');
  s = s.replace(/<\/(td|th)>/gi, '\t');
  s = s.replace(/<li[^>]*>/gi, '• ');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/\u0001/g, '<').replace(/\u0002/g, '>');
  // Decode the most common entities; leave the rest as-is.
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/gi, '&');
  // Collapse runs of >2 newlines and trim trailing whitespace per line.
  s = s.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n');
  return s.trim();
}

/**
 * Remove a balanced `<tag …>…</tag>` block (nesting-aware) for every
 * occurrence in `html`. Used to drop quoted content before keyword matching.
 */
function removeBalancedBlocks(html: string, openRe: RegExp, tag: string): string {
  let out = html;
  let m: RegExpExecArray | null;
  const open = new RegExp(openRe.source, 'i');
  // eslint-disable-next-line no-cond-assign
  while ((m = open.exec(out)) !== null) {
    const start = m.index;
    let depth = 0;
    let i = start;
    const tokenRe = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
    tokenRe.lastIndex = start;
    let end = -1;
    let tok: RegExpExecArray | null;
    // eslint-disable-next-line no-cond-assign
    while ((tok = tokenRe.exec(out)) !== null) {
      i = tok.index;
      if (tok[0].startsWith('</')) {
        depth--;
        if (depth === 0) {
          end = i + tok[0].length;
          break;
        }
      } else {
        depth++;
      }
    }
    if (end === -1) {
      out = out.slice(0, start);
      break;
    }
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

/**
 * The text the user actually wrote: the body minus the quoted original
 * (`data-quoted-html` island / blockquotes) and everything from the forwarded
 * separator onward. Port of the webmail's `extractUserAuthoredText` (#570).
 */
export function extractUserAuthoredText(
  body: string,
  options: { plainTextMode?: boolean; forwardedSeparator?: string } = {},
): string {
  const { plainTextMode = false, forwardedSeparator } = options;

  let text: string;
  if (plainTextMode) {
    text = body
      .split('\n')
      .filter((line) => !/^\s*>/.test(line))
      .join('\n');
  } else {
    let html = removeBalancedBlocks(body, new RegExp(`<div\\b[^>]*\\s${QUOTED_BLOCK_ATTR}\\b`), 'div');
    html = removeBalancedBlocks(html, /<blockquote\b/, 'blockquote');
    text = htmlToPlainText(html);
  }

  const trimmedSeparator = forwardedSeparator?.trim();
  if (trimmedSeparator) {
    const pattern = trimmedSeparator
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s+');
    const match = text.match(new RegExp(pattern));
    if (match && match.index !== undefined) {
      text = text.slice(0, match.index);
    }
  }

  return text;
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

// Transparent 1x1 GIF used as a stand-in src while the real inline image is
// being fetched from JMAP (webmail #163).
export const INLINE_IMAGE_PLACEHOLDER =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * Rewrites `<img src="cid:xxx">` references into
 * `<img src="<placeholder>" data-cid="xxx">` so the editor can render the
 * quoted original (a `cid:` URL would show a broken image) while still
 * carrying the cid through edits. Returns the cids found.
 */
export function rewriteCidImagesForEditor(html: string): { html: string; cids: string[] } {
  if (!html || html.indexOf('cid:') === -1) return { html, cids: [] };
  const cids = new Set<string>();
  const out = html.replace(
    /<img\b([^>]*?)\ssrc=("cid:([^"]*)"|'cid:([^']*)')([^>]*)>/gi,
    (_full, before: string, _q: string, dq: string | undefined, sq: string | undefined, after: string) => {
      const cid = (dq ?? sq ?? '').trim();
      if (!cid) return _full;
      cids.add(cid);
      const rest = (before + after).replace(/\sdata-cid=("[^"]*"|'[^']*')/gi, '').trim();
      return `<img src="${INLINE_IMAGE_PLACEHOLDER}" data-cid="${cid.replace(/"/g, '&quot;')}"${rest ? ' ' + rest : ''}>`;
    },
  );
  return { html: out, cids: Array.from(cids) };
}

/**
 * Replace the placeholder src on `<img data-cid="...">` elements with the
 * resolved data URL once the inline blob has been fetched.
 */
export function replaceInlineImagePlaceholders(
  html: string,
  cidToDataUrl: Map<string, string>,
): string {
  if (!html || cidToDataUrl.size === 0 || html.indexOf('data-cid') === -1) return html;
  return html.replace(
    /<img\b([^>]*?)\sdata-cid=("([^"]*)"|'([^']*)')([^>]*)>/gi,
    (full, before: string, _q: string, dq: string | undefined, sq: string | undefined, after: string) => {
      const cid = dq ?? sq ?? '';
      const dataUrl = cidToDataUrl.get(cid);
      if (!dataUrl) return full;
      const rest = (before + after).replace(/\ssrc=("[^"]*"|'[^']*')/gi, '').trim();
      return `<img src="${dataUrl}" data-cid="${cid.replace(/"/g, '&quot;')}"${rest ? ' ' + rest : ''}>`;
    },
  );
}

/**
 * Sniffs the real image MIME type from a blob's leading magic bytes, returning
 * null when the bytes aren't a recognizable image (webmail #543).
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (!bytes || bytes.length < 4) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image/webp';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  return null;
}
