// The questions the composer asks before a message goes out, shared with
// quick reply so it is no way around them (webmail lib/outgoing/quick-reply.ts,
// 534049952).

import { unfilledPlaceholdersInMessage, type PlaceholderWords } from './placeholder-check';

/** A question asked before sending. */
export type SendQuestion =
  | { kind: 'placeholders'; found: string[] }
  | { kind: 'attachment'; keyword: string }
  | { kind: 'send'; count: number };

/**
 * The first attachment keyword in `text`, matched as a whole word so
 * "attach" does not fire on "detached". Case-insensitive; blank keywords
 * are skipped.
 */
export function findAttachmentKeyword(text: string, keywords: readonly string[]): string | undefined {
  const haystack = text.toLowerCase();
  return keywords.find((kw) => {
    const k = kw.trim().toLowerCase();
    if (!k) return false;
    return new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(haystack);
  });
}

export interface QuickReplyChecks {
  /** The typed reply, without the quote and the signature. */
  body: string;
  /** The fill-in words of the placeholder warning; null when it is off. */
  placeholderWords: PlaceholderWords[] | null;
  /** The keywords of the attachment reminder; null when it is off. */
  attachmentKeywords: readonly string[] | null;
  /** "Confirm before sending" is on. */
  confirmSend: boolean;
  /** How many addresses the reply goes to, for the confirm. */
  recipientCount: number;
  /** Resolves true to send anyway. */
  ask: (question: SendQuestion) => Promise<boolean>;
}

/**
 * The composer's warnings for a quick reply, in the composer's order:
 * placeholders, the forgotten attachment, then "Send this message?" last so
 * an answered warning doesn't ask twice. Only the typed text counts: the
 * subject and the signature are not the user's words here, and a quick reply
 * carries no attachments, so any keyword is a reminder. Resolves true when
 * the reply may go out.
 */
export async function passesQuickReplyChecks(input: QuickReplyChecks): Promise<boolean> {
  if (input.placeholderWords) {
    const found = unfilledPlaceholdersInMessage({
      subject: '',
      body: input.body,
      plainTextMode: true,
      words: input.placeholderWords,
    });
    if (found.length > 0 && !(await input.ask({ kind: 'placeholders', found }))) return false;
  }
  if (input.attachmentKeywords) {
    const keyword = findAttachmentKeyword(input.body, input.attachmentKeywords);
    if (keyword && !(await input.ask({ kind: 'attachment', keyword }))) return false;
  }
  if (input.confirmSend && !(await input.ask({ kind: 'send', count: input.recipientCount }))) return false;
  return true;
}
