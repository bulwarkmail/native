// Turn a full JMAP Email (Drafts folder row, cancelled scheduled send, undone
// delayed send) into the composer's `draft` route param.

import type { Email } from '../api/types';
import type { ComposeDraftContext } from '../navigation/types';
import { messagePriorityFromHeaders } from './message-priority';

/**
 * Pick the draft's bodies by MIME type. A plain-text-only message lists its
 * text/plain part under `htmlBody` too (RFC 8621 §4.1.4), so only treat the
 * html part as HTML when it really is (webmail #649).
 */
export function draftBodies(email: Pick<Email, 'textBody' | 'htmlBody' | 'bodyValues'>): { htmlBody?: string; textBody?: string } {
  const htmlPart = email.htmlBody?.[0];
  const textPart = email.textBody?.[0];
  const htmlIsHtml = !!htmlPart?.partId && (!htmlPart.type || htmlPart.type.toLowerCase() === 'text/html');
  const textIsText = !!textPart?.partId && (!textPart.type || textPart.type.toLowerCase() === 'text/plain');
  const htmlBody = htmlIsHtml && htmlPart?.partId ? email.bodyValues?.[htmlPart.partId]?.value : undefined;
  const textBody = textIsText && textPart?.partId ? email.bodyValues?.[textPart.partId]?.value : undefined;
  return { htmlBody: htmlBody || undefined, textBody: textBody || undefined };
}

export function draftContextFromEmail(email: Email, jmapAccountId?: string): ComposeDraftContext {
  const { htmlBody, textBody } = draftBodies(email);
  return {
    id: email.id,
    jmapAccountId,
    from: email.from ?? undefined,
    to: email.to ?? undefined,
    cc: email.cc ?? undefined,
    bcc: email.bcc ?? undefined,
    subject: email.subject ?? '',
    htmlBody,
    textBody,
    // Inline images referenced from the body are re-hydrated by the composer;
    // everything else rides along as a blob reference.
    attachments: email.attachments ?? undefined,
    messageId: email.messageId ?? undefined,
    inReplyTo: email.inReplyTo ?? undefined,
    references: email.references ?? undefined,
    // Read back from the headers it was saved with (webmail #970).
    priority: messagePriorityFromHeaders(email.headers),
  };
}

/**
 * A row that should open the composer instead of the reader: anything in the
 * Drafts folder, or a message flagged `$draft` elsewhere.
 */
export function isDraftEmail(
  email: Pick<Email, 'keywords'> | null | undefined,
  mailboxRole?: string | null,
): boolean {
  if (mailboxRole === 'drafts') return true;
  return !!email?.keywords?.$draft;
}
