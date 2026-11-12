// One signature field with formatting (webmail components/identity/
// signature-editor.tsx): the plain-text part is made from the formatted one
// on every change, so the two can't drift apart.

import { escapeHtml } from './email-html';
import { htmlToPlainText } from './compose-html';
import { sanitizeSignatureHtml } from './signature-utils';

/** Plain text as the formatting editor takes it: a paragraph per block, a <br> per newline. */
export function textToParagraphHtml(text: string): string {
  const trimmed = text.replace(/\r\n?/g, '\n').trim();
  if (!trimmed) return '';
  return trimmed
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** The plain-text part a save sends with a formatted signature. */
export function textFromSignatureHtml(html: string): string {
  const clean = sanitizeSignatureHtml(html);
  return clean ? htmlToPlainText(clean).trim() : '';
}

/** Whether a formatted signature holds anything: text, or a picture. */
function hasSignatureContent(html: string): boolean {
  const clean = sanitizeSignatureHtml(html);
  return !!clean && (!!htmlToPlainText(clean).trim() || /<img\b/i.test(clean));
}

/** Both fields after an edit of the formatted signature; an empty editor clears both. */
export function signatureFromHtml(html: string): { htmlSignature: string; textSignature: string } {
  const kept = hasSignatureContent(html) ? html : '';
  return { htmlSignature: kept, textSignature: kept ? textFromSignatureHtml(kept) : '' };
}

/** What the formatting editor opens with: the HTML, else the text as paragraphs. */
export function signatureEditorSeed(html: string, text: string): string {
  return html || textToParagraphHtml(text);
}
