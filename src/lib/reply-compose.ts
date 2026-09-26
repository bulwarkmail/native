import type { Email } from '../api/types';
import type { RootStackParamList } from '../navigation/types';
import { pickEmailBody, plainTextBody } from './email-body';

/**
 * Composer params for a reply / reply-all / forward of `source`. Shared by
 * the thread viewer and the `mail/message/<id>?action=reply` deep link (the
 * triage widget). Null when there is nobody to reply to.
 */
export function replyComposeParams(
  mode: 'reply' | 'replyAll' | 'forward',
  source: Email,
  ownerAccountId?: string,
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
    replyTo: {
      from: from ?? { email: '' },
      to: source.to,
      cc: source.cc,
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
      // Forward carries the original attachments as blob refs; cid-embedded
      // inline images are already part of the quoted HTML.
      attachments: mode === 'forward'
        ? (source.attachments ?? []).filter((a) => !(a.disposition === 'inline' && a.cid))
        : undefined,
      originalEmailId: source.id,
      jmapAccountId: ownerAccountId,
    },
  };
}
