import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isEmbeddedInBody, visibleAttachments } from '../attachment-display';
import type { Attachment, Email } from '../../api/types';

// Exchange's second copy of an inline image showed as an attachment chip,
// and an HTML message read as plain text listed none of its inline images
// (webmail lib/attachment-visibility.ts, c8900fe06, e49de8a04, #1614).

const body = new Set(['image001.png', 'image002.png']);
const none = new Set<string>();
const inline1 = { cid: 'image001.png', type: 'image/png', size: 23567, disposition: 'inline' };
const inline2 = { cid: 'image002.png', type: 'image/png', size: 26526, disposition: 'inline' };
const copy1 = { cid: 'image001.png', type: 'image/png', size: 23567, disposition: 'attachment' };
const copy2 = { cid: 'image002.png', type: 'image/png', size: 26526, disposition: 'attachment' };
const invoice = { cid: undefined, type: 'application/pdf', size: 51200, disposition: 'attachment' };
const parts = [inline1, inline2, copy1, copy2, invoice];

describe('attached copies of embedded images', () => {
  it('hides the copies along with the images they repeat, and keeps the real file', () => {
    expect(parts.filter((part) => !isEmbeddedInBody(part, body, parts))).toEqual([invoice]);
  });

  it('keeps a copy the body does not show, or that differs, or with nothing to compare', () => {
    expect(isEmbeddedInBody(copy1, body)).toBe(false);
    expect(isEmbeddedInBody(copy1, new Set(['image002.png']), parts)).toBe(false);
    expect(isEmbeddedInBody(copy1, body, [copy1, copy2, invoice])).toBe(false);
    expect(isEmbeddedInBody({ ...copy1, size: 23568 }, body, [inline1, { ...copy1, size: 23568 }])).toBe(false);
    expect(isEmbeddedInBody({ ...copy1, type: 'image/jpeg' }, body, [inline1, { ...copy1, type: 'image/jpeg' }])).toBe(false);
  });

  it('lists each image once, by its copy, when the message is shown as plain text', () => {
    expect(parts.filter((part) => !isEmbeddedInBody(part, none, parts, { plainText: true }))).toEqual([copy1, copy2, invoice]);
    const logo = { cid: 'logo', type: 'image/png', size: 900, disposition: 'inline' };
    expect(isEmbeddedInBody(logo, new Set(['logo']), [logo], { plainText: true })).toBe(false);
  });

  it('lists the inline images of a message read as plain text', () => {
    const email = {
      attachments: [{ ...inline1, blobId: 'b1', name: 'image001.png' }] as Attachment[],
      htmlBody: [{ partId: '1', type: 'text/html' }],
      textBody: [{ partId: '1', type: 'text/html' }],
      bodyValues: { 1: { value: '<p>Hi</p><img src="cid:image001.png">' } },
    } as unknown as Email;
    const opts = { hideInlineImageAttachments: true, calendarBannerShown: false };
    expect(visibleAttachments(email, opts)).toHaveLength(0);
    expect(visibleAttachments(email, { ...opts, plainText: true })).toHaveLength(1);
  });

  it('is told about the plain-text view by the reader', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '../..', p), 'utf8');
    expect(read('components/email/MessageContent.tsx')).toMatch(/plainView=\{plainView \?\? plainTextMode\}/);
    expect(read('components/email/AttachmentChips.tsx')).toMatch(/visibleAttachments\(email, \{ hideInlineImageAttachments, calendarBannerShown, tnefUnpacked, plainText: plainView \}\)/);
  });
});
