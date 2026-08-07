// Map a fetched draft Email back into composer state so it can be re-edited.
// JMAP emails are immutable apart from keywords/mailboxIds (RFC 8621 §4), so
// the composer re-creates the draft on save/send and destroys the original;
// attachments are reused by blobId without re-uploading.

import type { Email, EmailAddress } from '../api/types';
import { escapeHtml, stripDangerousTags } from './email-html';

export interface DraftAttachmentInit {
  blobId: string;
  type: string;
  name: string;
  size: number;
  cid?: string;
  inline: boolean;
}

export interface DraftComposeInit {
  to: EmailAddress[];
  cc: EmailAddress[];
  bcc: EmailAddress[];
  subject: string;
  bodyHtml: string;
  attachments: DraftAttachmentInit[];
  inReplyTo?: string;
  references?: string;
}

function extractBody(email: Email, kind: 'htmlBody' | 'textBody'): string | null {
  for (const part of email[kind] ?? []) {
    const v = part.partId ? email.bodyValues?.[part.partId]?.value : undefined;
    if (v) return v;
  }
  return null;
}

export function draftToComposeInit(email: Email): DraftComposeInit {
  const html = extractBody(email, 'htmlBody');
  const text = extractBody(email, 'textBody');
  const bodyHtml = html
    ? stripDangerousTags(html)
    : escapeHtml(text ?? '').replace(/\n/g, '<br>');

  const attachments: DraftAttachmentInit[] = (email.attachments ?? [])
    .filter((a) => !!a.blobId)
    .map((a) => ({
      blobId: a.blobId,
      type: a.type || 'application/octet-stream',
      name: a.name ?? 'attachment',
      size: a.size ?? 0,
      cid: a.cid?.replace(/^<|>$/g, ''),
      inline: a.disposition === 'inline' && !!a.cid,
    }));

  return {
    to: email.to ?? [],
    cc: email.cc ?? [],
    bcc: email.bcc ?? [],
    subject: email.subject ?? '',
    bodyHtml,
    attachments,
    inReplyTo: email.inReplyTo?.[0],
    references: email.references?.join(' '),
  };
}

// Swap `src="cid:X"` references for fetched data: URLs and stamp the editor's
// `data-cid` marker so `rewriteInlineImages` can turn them back into cid parts
// at send time. Images whose cid is missing from the map are left untouched.
export function rewriteCidSrcToDataUrls(
  html: string,
  dataUrlByCid: Record<string, string>,
): string {
  if (!html || !/src=("|')cid:/i.test(html)) return html;
  return html.replace(
    /<img\b([^>]*?)\ssrc=("cid:([^"]*)"|'cid:([^']*)')([^>]*)>/gi,
    (full, before: string, _quoted: string, dq: string | undefined, sq: string | undefined, after: string) => {
      const cid = (dq ?? sq ?? '').replace(/^<|>$/g, '');
      const dataUrl = dataUrlByCid[cid];
      if (!dataUrl) return full;
      return `<img${before} src="${dataUrl}" data-cid="${cid}"${after}>`;
    },
  );
}
