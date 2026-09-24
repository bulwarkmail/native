// Signature helpers for the composer. Port of the webmail's
// lib/signature-utils.ts plus the embedded-signature block builder from
// components/email/email-composer.tsx (buildEmbeddedSignatureHtml).
//
// The RN editor is a plain contenteditable (no Tiptap atom), so the signature
// is bracketed by `data-signature-block` marker paragraphs and is always
// editable. The markers let an identity switch swap just the signature
// without touching the draft text or the quoted message.

import { stripDangerousTags } from './email-html';
import { htmlToPlainText } from './compose-html';

export type SignatureSource = {
  textSignature?: string;
  htmlSignature?: string;
} | null | undefined;

export const SIGNATURE_RANGE_MARKER = 'data-signature-block';

const SIGNATURE_ALLOWED_TAGS = new Set([
  'p', 'br', 'b', 'strong', 'i', 'em', 'u', 'a', 'span', 'div', 'img',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
]);
const SIGNATURE_ALLOWED_ATTRS = new Set([
  'href', 'style', 'class', 'src', 'alt', 'width', 'height', 'title',
  'cellpadding', 'cellspacing', 'border', 'valign', 'align', 'bgcolor',
  'colspan', 'rowspan',
]);

/**
 * Sanitize an HTML signature for storage and for the outgoing message. A
 * regex allowlist stands in for the webmail's DOMPurify config
 * (SIGNATURE_SANITIZE_CONFIG): formatting, links, images and tables only; no
 * script, no event handlers, no external URI schemes; images only over https:
 * or as a base64 raster data: URI.
 */
export function sanitizeSignatureHtml(html: string): string {
  if (!html?.trim()) return '';
  const stripped = stripDangerousTags(html);
  return stripped.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (full, rawTag: string, rawAttrs: string) => {
    const tag = rawTag.toLowerCase();
    if (!SIGNATURE_ALLOWED_TAGS.has(tag)) return '';
    if (full.startsWith('</')) return `</${tag}>`;
    const attrs: string[] = [];
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(rawAttrs)) !== null) {
      const name = m[1].toLowerCase();
      if (!SIGNATURE_ALLOWED_ATTRS.has(name)) continue;
      const value = m[3] ?? m[4] ?? m[5] ?? '';
      if (name === 'href' && !/^(https?:|mailto:|tel:)/i.test(value.trim())) continue;
      if (name === 'src' && !/^(?:https:\/\/|data:image\/(?:png|jpe?g|gif|webp);base64,)/i.test(value.trim())) {
        // An image with a disallowed source is dropped entirely.
        return '';
      }
      if (name === 'style' && /expression\s*\(|url\s*\(\s*['"]?\s*javascript:/i.test(value)) continue;
      attrs.push(`${name}="${value.replace(/"/g, '&quot;')}"`);
    }
    const selfClose = /\/\s*$/.test(rawAttrs) ? ' /' : '';
    return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}${selfClose}>`;
  });
}

function normalizeSignatureLineBreaks(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function hasSignature(signature?: SignatureSource): boolean {
  return !!(signature?.htmlSignature?.trim() || signature?.textSignature?.trim());
}

/**
 * The identity whose signature a message sent as `identity` carries: its own,
 * or - for an alias or shared identity without one - the primary identity's
 * (the first that can't be deleted, else the first). Null when neither has a
 * signature.
 */
export function signatureIdentityFor<T extends { textSignature?: string; htmlSignature?: string; mayDelete?: boolean }>(
  identity: T | null | undefined,
  identities: T[],
): T | null {
  if (!identity) return null;
  if (hasSignature(identity)) return identity;
  const primary = identities.find((i) => !i.mayDelete) ?? identities[0];
  return primary && hasSignature(primary) ? primary : null;
}

export function getPlainTextSignature(signature?: SignatureSource): string {
  if (signature?.textSignature?.trim()) {
    return normalizeSignatureLineBreaks(signature.textSignature);
  }

  if (signature?.htmlSignature?.trim()) {
    return htmlToPlainText(sanitizeSignatureHtml(signature.htmlSignature));
  }

  return '';
}

export function appendPlainTextSignature(
  body: string,
  signature?: SignatureSource,
  options: { separator?: boolean } = {},
): string {
  const plainTextSignature = getPlainTextSignature(signature);
  if (!plainTextSignature) {
    return body;
  }

  const sep = options.separator === false ? '\n\n' : '\n\n-- \n';
  return `${body}${sep}${plainTextSignature}`;
}

/**
 * A plain-text reply signed the way the composer signs one: the signature
 * between the reply and the quote (`above_quote`), or at the very end.
 */
export function signPlainTextReply(
  reply: string,
  quote: string,
  signature: SignatureSource,
  options: { position: 'above_quote' | 'below_quote'; separator: boolean },
): string {
  const quoted = quote ? `\n\n${quote}` : '';
  if (options.position === 'above_quote') {
    return `${appendPlainTextSignature(reply, signature, options)}${quoted}`;
  }
  return appendPlainTextSignature(`${reply}${quoted}`, signature, options);
}

/**
 * Whether a plain-text body already ends with the identity's signature.
 */
export function plainTextBodyHasSignature(
  body: string,
  signature?: SignatureSource,
): boolean {
  const plainTextSignature = getPlainTextSignature(signature);
  if (!plainTextSignature) {
    return false;
  }
  return normalizeSignatureLineBreaks(body).endsWith(plainTextSignature);
}

/**
 * The plain-text body with a trailing signature - and the `-- ` separator
 * line in front of it - removed. Returns the body unchanged when it does not
 * end with the identity's signature.
 */
export function plainTextBodyWithoutSignature(
  body: string,
  signature?: SignatureSource,
): string {
  const plainTextSignature = getPlainTextSignature(signature);
  if (!plainTextSignature) {
    return body;
  }
  const normalized = normalizeSignatureLineBreaks(body);
  if (!normalized.endsWith(plainTextSignature)) {
    return body;
  }
  return normalized
    .slice(0, normalized.length - plainTextSignature.length)
    .replace(/\n*(?:-- ?)?\n*$/, '');
}

function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

/**
 * Append a signature to an HTML body, preserving rich formatting (quick
 * reply path, no markers).
 */
export function appendHtmlSignature(
  htmlBody: string,
  signature?: SignatureSource,
  options: { separator?: boolean } = {},
): string {
  const sep = options.separator === false ? '<br><br>' : '<br><br>-- <br>';

  if (signature?.htmlSignature?.trim()) {
    return `${htmlBody}${sep}${sanitizeSignatureHtml(signature.htmlSignature)}`;
  }

  if (signature?.textSignature?.trim()) {
    return `${htmlBody}${sep}${escapeText(signature.textSignature)}`;
  }

  return htmlBody;
}

/**
 * Render the embedded, editable signature range: a `-- ` separator paragraph
 * (or an empty start marker), the signature, and an end marker. Returns ''
 * when the identity has no signature.
 */
export function buildEmbeddedSignatureHtml(
  identity: SignatureSource,
  options: { separator: boolean },
): string {
  const startMarker = options.separator
    ? `<p ${SIGNATURE_RANGE_MARKER}="separator">-- </p>`
    : `<p ${SIGNATURE_RANGE_MARKER}="start"></p>`;
  const endMarker = `<p ${SIGNATURE_RANGE_MARKER}="end"><br></p>`;
  if (identity?.htmlSignature?.trim()) {
    return `${startMarker}<div ${SIGNATURE_RANGE_MARKER}="body">${sanitizeSignatureHtml(identity.htmlSignature)}</div>${endMarker}`;
  }
  if (identity?.textSignature?.trim()) {
    return `${startMarker}<p ${SIGNATURE_RANGE_MARKER}="body">${escapeText(identity.textSignature)}</p>${endMarker}`;
  }
  return '';
}

const SIGNATURE_RANGE_RE = new RegExp(
  `<p\\s+${SIGNATURE_RANGE_MARKER}=["'](?:separator|start)["'][^>]*>[\\s\\S]*?<p\\s+${SIGNATURE_RANGE_MARKER}=["']end["'][^>]*>(?:<br\\s*/?>)?</p>`,
  'i',
);

/** True when the body carries an embedded signature range. */
export function containsEmbeddedSignature(html: string): boolean {
  return SIGNATURE_RANGE_RE.test(html);
}

/**
 * Replace the embedded signature range with `nextSignatureHtml` (which may
 * be '' to remove it). When the body has no range yet, the signature is
 * appended at the end. Returns the body unchanged when nothing changes.
 */
export function spliceSignature(html: string, nextSignatureHtml: string): string {
  if (SIGNATURE_RANGE_RE.test(html)) {
    return html.replace(SIGNATURE_RANGE_RE, () => nextSignatureHtml);
  }
  if (!nextSignatureHtml) return html;
  return `${html}${nextSignatureHtml}`;
}

/** The body without its embedded signature range. */
export function stripEmbeddedSignature(html: string): string {
  return html.replace(SIGNATURE_RANGE_RE, '');
}

/**
 * Insert the signature range in front of the quoted block (`On … wrote:` /
 * forwarded header) or, when there is none, at the end of the body.
 */
export function insertSignatureAboveQuote(html: string, signatureHtml: string, quoteStartMarker: string): string {
  if (!signatureHtml) return html;
  const idx = quoteStartMarker ? html.indexOf(quoteStartMarker) : -1;
  if (idx === -1) return `${html}${signatureHtml}`;
  return `${html.slice(0, idx)}${signatureHtml}${html.slice(idx)}`;
}
