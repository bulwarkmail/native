import type { Attachment, Email } from '../api/types';
import type { RootStackParamList } from '../navigation/types';
import { pickEmailBody, plainTextBody } from './email-body';
import { extractCidRefs } from './email-html';
import { stripMessageIdBrackets } from './email-threading';

/**
 * The parts a reply or forward hands the composer. The inline images the
 * quoted HTML embeds go along in both modes: the composer fetches them into
 * the quote and attaches them again on send (it never shows them as chips).
 * Without them a quoted `cid:` image went out pointing at a part the new
 * message did not have. A forward also carries the real attachments.
 */
function carriedParts(mode: 'reply' | 'replyAll' | 'forward', source: Email, quoteHtml?: string): Attachment[] | undefined {
  const quoted = new Set(quoteHtml ? extractCidRefs(quoteHtml) : []);
  const isQuoted = (a: Attachment) => !!a.cid && quoted.has(stripMessageIdBrackets(a.cid));
  const parts = (source.attachments ?? []).filter((a) =>
    isQuoted(a) || (mode === 'forward' && !(a.disposition === 'inline' && a.cid)));
  return parts.length > 0 || mode === 'forward' ? parts : undefined;
}

/**
 * Composer params for a reply / reply-all / forward of `source`. Shared by
 * the thread viewer and the `mail/message/<id>?action=reply` deep link (the
 * triage widget). Null when there is nobody to reply to. `typed` is text
 * the user already wrote (quick reply's "More options"); it goes above the
 * quote.
 */
export function replyComposeParams(
  mode: 'reply' | 'replyAll' | 'forward',
  source: Email,
  ownerAccountId?: string,
  typed?: string,
): NonNullable<RootStackParamList['Compose']> | null {
  const from = source.from?.[0];
  if (!from && mode !== 'forward') return null;
  // Quote the HTML part when there is one so layout and inline images
  // survive (#163). RFC 8621 §4.1.4: an HTML-only message exposes the same
  // part in `textBody` and `htmlBody`, so the text part is only a real
  // alternative when its partId differs - otherwise the composer would be
  // handed raw HTML source (#649, native #46).
  const picked = pickEmailBody(source);
  const quoteHtml = picked.html ?? undefined;
  const body = !quoteHtml || picked.text ? plainTextBody(source) : undefined;
  return {
    mode,
    ...(typed?.trim() ? { prefillBody: typed } : null),
    replyTo: {
      from: from ?? { email: '' },
      to: source.to,
      cc: source.cc,
      // Never a recipient of the reply, but the composer picks the identity
      // (and the catch-all From) by the address the message was delivered
      // to, and a Sieve rule or a list may name that one only in Bcc.
      bcc: source.bcc,
      // RFC 5322: a reply goes to Reply-To when the sender set one.
      replyToAddresses: source.replyTo,
      subject: source.subject ?? '',
      body,
      htmlBody: quoteHtml,
      receivedAt: source.receivedAt,
      sentAt: source.sentAt,
      // Threading needs the RFC Message-ID, never the JMAP object id (#234).
      messageId: source.messageId ?? undefined,
      references: source.references ?? undefined,
      attachments: carriedParts(mode, source, quoteHtml),
      originalEmailId: source.id,
      jmapAccountId: ownerAccountId,
    },
  };
}
