import type { BodyPart, Email } from '../api/types';
import { hasMeaningfulHtmlBody } from './email-html';

export interface PickedBody {
  /** The HTML alternative, when the message really has one. */
  html: string | null;
  /** The plain-text alternative, when it is a distinct part. */
  text: string | null;
}

function partType(part: BodyPart): 'html' | 'text' | 'other' {
  const t = (part.type || '').split(';')[0].trim().toLowerCase();
  if (!t) return 'other';
  if (t === 'text/html') return 'html';
  if (t === 'text/plain') return 'text';
  return 'other';
}

/**
 * Pick the HTML and text bodies of a message per RFC 8621 §4.1.4.
 *
 * An HTML-only message exposes the SAME part in `textBody` and `htmlBody`
 * (the server's best-effort alternative), and a text-only message likewise
 * lists its text part in both. Treating `textBody[0]` as a real alternative
 * without comparing part ids rendered HTML-only mail as raw source (native
 * #46) and quoted it that way in replies. Routing is by the part's `type`
 * first and by distinct `partId` second.
 */
export function pickEmailBody(
  email: Pick<Email, 'htmlBody' | 'textBody' | 'bodyValues'>,
): PickedBody {
  const values = email.bodyValues ?? {};
  let html: string | null = null;
  let text: string | null = null;
  const htmlIds = new Set<string>();

  for (const part of email.htmlBody ?? []) {
    if (!part.partId) continue;
    const v = values[part.partId]?.value;
    if (!v) continue;
    const kind = partType(part);
    if (kind === 'html' || (kind === 'other' && !part.type)) {
      if (html === null) { html = v; htmlIds.add(part.partId); }
    } else if (kind === 'text' && text === null) {
      text = v;
    }
  }

  for (const part of email.textBody ?? []) {
    if (!part.partId || htmlIds.has(part.partId)) continue;
    const v = values[part.partId]?.value;
    if (!v) continue;
    const kind = partType(part);
    if (kind === 'text' || (kind === 'other' && !part.type)) {
      if (text === null) text = v;
    } else if (kind === 'html' && html === null) {
      html = v;
      htmlIds.add(part.partId);
    }
  }

  return { html, text };
}

/**
 * True when a part the viewer shows (the first HTML or text body part) came
 * back cut off at `maxBodyValueBytes`. Truncated text/* attachments, which
 * `fetchAllBodyValues` also returns, don't count. (#884)
 */
export function hasTruncatedDisplayedBody(
  email: Pick<Email, 'htmlBody' | 'textBody' | 'bodyValues'>,
): boolean {
  const values = email.bodyValues;
  if (!values) return false;
  const htmlPartId = email.htmlBody?.[0]?.partId;
  const textPartId = email.textBody?.[0]?.partId;
  return Boolean(
    (htmlPartId && values[htmlPartId]?.isTruncated)
    || (textPartId && values[textPartId]?.isTruncated),
  );
}

/**
 * Which alternative to render: the HTML part unless it is a minimal
 * auto-generated wrapper around the text alternative (which would collapse
 * newlines) - the webmail's `hasMeaningfulHtmlBody` preference.
 */
export function selectRenderableHtml(picked: PickedBody): string | null {
  if (!picked.html) return null;
  if (!picked.text) return picked.html;
  return hasMeaningfulHtmlBody(picked.html) ? picked.html : null;
}

/** Plain-text body for quoting / quick reply; never returns HTML source. */
export function plainTextBody(email: Pick<Email, 'htmlBody' | 'textBody' | 'bodyValues' | 'preview'>): string {
  const picked = pickEmailBody(email);
  if (picked.text) return picked.text;
  return email.preview ?? '';
}
