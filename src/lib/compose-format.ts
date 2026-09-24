// The composer's per-message HTML <-> plain-text switch (#1022). Port of the
// webmail's components/email/compose-format.ts.
//
// Both directions keep what the send, draft-save and identity-switch paths
// rely on: whether (and where) the body carries the signature. An HTML body
// carries it as a marker-bracketed range (`containsEmbeddedSignature`), a
// plain-text body as the signature text after its separator. The converters
// take the signature out in the source format and put it back, in the same
// place, in the target format, so a switch never doubles or loses it.

import { escapeHtml } from './email-html';
import { htmlToPlainText } from './compose-html';
import {
  buildEmbeddedSignatureHtml, containsEmbeddedSignature, getPlainTextSignature,
  plainTextBodyHasSignature, plainTextBodyWithoutSignature, spliceSignature,
  type SignatureSource,
} from './signature-utils';

/**
 * The format a composer opens in. A reopened draft keeps the one it was
 * written in - an HTML draft used to be flattened by the "plain text only"
 * setting on its first autosave. An empty draft and every new message follow
 * the setting.
 */
export function initialPlainTextMode(
  draft: { htmlBody?: string; textBody?: string } | null | undefined,
  plainTextSetting: boolean,
): boolean {
  if (draft?.htmlBody) return false;
  if (draft?.textBody) return true;
  return plainTextSetting;
}

/** Plain text as editor HTML: a paragraph per blank line, `<br>` per newline. */
export function plainTextToComposerHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function separatorText(separator: boolean): string {
  return separator ? '\n\n-- \n' : '\n\n';
}

// Stands in for the signature while the rest of the body is converted. Control
// characters survive `htmlToPlainText`, which only strips tags and entities.
const SIGNATURE_TOKEN = '\u0003signature\u0003';

/**
 * The rich-text body as a plain-text body. Formatting and inline images are
 * dropped (that is the point of plain text); an embedded signature comes back
 * as the identity's plain-text signature, where it was: at the end, or above
 * the quote.
 */
export function htmlComposeBodyToPlainText(
  html: string,
  identity: SignatureSource,
  options: { separator: boolean },
): string {
  if (!containsEmbeddedSignature(html)) return htmlToPlainText(html);
  const text = htmlToPlainText(spliceSignature(html, `<p>${SIGNATURE_TOKEN}</p>`));
  const at = text.indexOf(SIGNATURE_TOKEN);
  if (at === -1) return text;
  const head = text.slice(0, at).replace(/\s+$/, '');
  const tail = text.slice(at + SIGNATURE_TOKEN.length).replace(/^\s+/, '');
  const signature = getPlainTextSignature(identity);
  const withSignature = signature ? `${head}${separatorText(options.separator)}${signature}` : head;
  return tail ? `${withSignature}\n\n${tail}` : withSignature;
}

/**
 * A plain-text body as editor HTML. The identity's signature - after its
 * separator above the quote, or at the end - becomes the embedded,
 * marker-bracketed signature, so identity switches and sending keep working
 * as in a body that started out as HTML.
 */
export function plainComposeBodyToHtml(
  text: string,
  identity: SignatureSource,
  options: { separator: boolean },
): string {
  const empty = '<p><br></p>';
  const signature = getPlainTextSignature(identity);
  const embedded = signature ? buildEmbeddedSignatureHtml(identity, options) : '';
  if (embedded) {
    const marker = `${separatorText(options.separator)}${signature}`;
    const at = text.indexOf(marker);
    if (at !== -1) {
      const before = plainTextToComposerHtml(text.slice(0, at).replace(/^\n+/, ''));
      const after = plainTextToComposerHtml(text.slice(at + marker.length).replace(/^\n+/, ''));
      return `${before || empty}${embedded}${after}`;
    }
    if (plainTextBodyHasSignature(text, identity)) {
      const before = plainTextToComposerHtml(plainTextBodyWithoutSignature(text, identity).replace(/^\n+/, ''));
      return `${before || empty}${embedded}`;
    }
  }
  return plainTextToComposerHtml(text) || empty;
}
