// Non-text parts that sit in a message's body lists but not in `attachments`.
//
// RFC 8621 §4.1.4 puts an inline image, audio or video part that sits
// directly in multipart/mixed into textBody and htmlBody only: it is meant to
// show at that place in the body, so it is not an attachment. Stalwart 1.0
// follows that; 0.16 also listed such a part in `attachments`. The app saves
// a draft with an inline image exactly that way (an HTML body plus an inline
// part with a Content-ID), and everything that resolves `cid:` images or
// carries parts over (viewer, re-opened draft, forward, the draft's part
// blobs) reads `attachments`. So on 1.0 the image vanished from all of them.
// Taking those parts into the attachment list makes 1.0 read like 0.16.

import type { Attachment, BodyPart, Email } from '../api/types';

const isTextPart = (part: BodyPart) => (part.type ?? '').toLowerCase().startsWith('text/');

// Body parts carry a partId; an attachment without one is matched by blob.
const partKey = (part: { partId?: string; blobId?: string }) => part.partId ?? `blob:${part.blobId ?? ''}`;

/**
 * The non-text parts of textBody/htmlBody that `attachments` lacks, in body
 * order, deduped by partId.
 */
export function inlineBodyParts(
  email: Pick<Email, 'attachments' | 'textBody' | 'htmlBody'>,
): Attachment[] {
  const seen = new Set((email.attachments ?? []).map((a) => partKey(a as Attachment & { partId?: string })));
  const out: Attachment[] = [];
  for (const part of [...(email.htmlBody ?? []), ...(email.textBody ?? [])]) {
    if (!part.blobId || isTextPart(part)) continue;
    const key = partKey(part);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...part, blobId: part.blobId, type: part.type ?? 'application/octet-stream' });
  }
  return out;
}

/**
 * The email with {@link inlineBodyParts} appended to its attachments. Returns
 * the same object when there is nothing to add (0.16, or no such parts), so
 * calling it twice is harmless.
 */
export function withInlineBodyParts<T extends Pick<Email, 'attachments' | 'textBody' | 'htmlBody'>>(email: T): T {
  const extra = inlineBodyParts(email);
  if (extra.length === 0) return email;
  return { ...email, attachments: [...(email.attachments ?? []), ...extra] };
}
