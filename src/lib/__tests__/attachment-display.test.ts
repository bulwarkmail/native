import { describe, it, expect } from 'vitest';
import {
  getAttachmentDisplayName, visibleAttachments, previewKindFor, isReportPart, isRfc822Attachment,
  isEmbeddedInBody,
} from '../attachment-display';
import { buildForwardAsAttachmentPayload } from '../forward-as-attachment';
import type { Email } from '../../api/types';

describe('getAttachmentDisplayName', () => {
  it('uses the name, else a MIME-derived label', () => {
    expect(getAttachmentDisplayName('a.pdf', 'application/pdf')).toBe('a.pdf');
    expect(getAttachmentDisplayName(null, 'application/pdf')).toBe('Document.pdf');
    expect(getAttachmentDisplayName(undefined, 'message/rfc822')).toBe('Email.eml');
    expect(getAttachmentDisplayName(undefined, 'application/x-foo')).toBe('Attachment.foo');
    expect(getAttachmentDisplayName(undefined, undefined)).toBe('Attachment');
  });
});

describe('visibleAttachments', () => {
  const email = {
    attachments: [
      { blobId: '1', type: 'image/png', name: 'logo.png', cid: 'logo', disposition: 'inline' },
      { blobId: '2', type: 'image/png', name: 'photo.png', cid: 'photo', disposition: 'attachment' },
      { blobId: '3', type: 'message/disposition-notification', name: undefined },
      { blobId: '4', type: 'text/calendar', name: 'invite.ics' },
      { blobId: '5', type: 'application/ms-tnef', name: 'winmail.dat' },
      { blobId: '6', type: 'application/pdf', name: 'doc.pdf' },
    ],
  };

  it('hides only inline-disposition cid images, report parts, shown calendar parts and unpacked TNEF', () => {
    const shown = visibleAttachments(email, { hideInlineImageAttachments: true, calendarBannerShown: true, tnefUnpacked: true });
    expect(shown.map((a) => a.blobId)).toEqual(['2', '6']);
  });

  it('keeps calendar parts and inline images when asked', () => {
    const shown = visibleAttachments(email, { hideInlineImageAttachments: false, calendarBannerShown: false });
    expect(shown.map((a) => a.blobId)).toEqual(['1', '2', '4', '5', '6']);
  });

  // Octet-stream, no disposition, no name, rendered in the body via cid:.
  const sloppy = {
    htmlBody: [{ partId: '1', type: 'text/html' }],
    textBody: [{ partId: '1', type: 'text/html' }],
    bodyValues: { '1': { value: '<p>Thanks</p><img src="cid:signaturImage">' } },
    attachments: [
      { blobId: 'a', type: 'application/octet-stream', cid: 'signaturImage' },
      { blobId: 'b', type: 'application/octet-stream', name: 'data.bin' },
      { blobId: 'c', type: 'application/octet-stream', cid: 'orphan' },
    ],
  };

  it('hides generically typed parts the rendered HTML body embeds by cid', () => {
    const shown = visibleAttachments(sloppy, { hideInlineImageAttachments: true, calendarBannerShown: false });
    expect(shown.map((a) => a.blobId)).toEqual(['b', 'c']);
    const all = visibleAttachments(sloppy, { hideInlineImageAttachments: false, calendarBannerShown: false });
    expect(all.map((a) => a.blobId)).toEqual(['a', 'b', 'c']);
  });

  it('hides nothing by reference when the message renders as plain text', () => {
    const text = {
      ...sloppy,
      textBody: [{ partId: '2', type: 'text/plain' }],
      // A minimal wrapper around the text alternative renders as text.
      bodyValues: { '1': { value: '<div>cid:signaturImage</div>' }, '2': { value: 'Thanks' } },
    };
    const shown = visibleAttachments(text, { hideInlineImageAttachments: true, calendarBannerShown: false });
    expect(shown.map((a) => a.blobId)).toEqual(['a', 'b', 'c']);
  });
});

describe('isEmbeddedInBody', () => {
  const body = new Set(['signaturImage', 'logoImage']);

  it('hides referenced octet-stream or untyped parts, with or without angle brackets', () => {
    expect(isEmbeddedInBody({ cid: 'signaturImage', type: 'application/octet-stream' }, body)).toBe(true);
    expect(isEmbeddedInBody({ cid: 'logoImage', type: '' }, body)).toBe(true);
    expect(isEmbeddedInBody({ cid: '<logoImage>', type: 'application/octet-stream' }, body)).toBe(true);
    expect(isEmbeddedInBody({ cid: 'logoImage', type: 'image/png' }, body)).toBe(true);
  });

  it('keeps hiding declared inline images even without a reference', () => {
    expect(isEmbeddedInBody({ cid: 'unreferenced', type: 'image/png', disposition: 'inline' }, body)).toBe(true);
  });

  it('keeps explicit attachments, referenced non-image types and unreferenced parts', () => {
    expect(isEmbeddedInBody({ cid: 'logoImage', type: 'image/png', disposition: 'attachment' }, body)).toBe(false);
    expect(isEmbeddedInBody({ cid: 'logoImage', type: 'application/pdf' }, body)).toBe(false);
    expect(isEmbeddedInBody({ cid: 'orphan', type: 'application/octet-stream' }, body)).toBe(false);
    expect(isEmbeddedInBody({ cid: 'orphan', type: 'image/png' }, body)).toBe(false);
    expect(isEmbeddedInBody({ type: 'image/png', disposition: 'inline' }, body)).toBe(false);
    expect(isEmbeddedInBody({ cid: 'logoImage', type: 'application/octet-stream' }, new Set())).toBe(false);
  });
});

describe('previewKindFor / classification', () => {
  it('classifies previewable types and refuses script-bearing ones', () => {
    expect(previewKindFor({ type: 'image/jpeg', name: 'a.jpg' })).toBe('image');
    expect(previewKindFor({ type: 'application/pdf', name: 'a.pdf' })).toBe('pdf');
    expect(previewKindFor({ type: 'text/plain', name: 'a.txt' })).toBe('text');
    expect(previewKindFor({ type: 'application/octet-stream', name: 'notes.md' })).toBe('text');
    expect(previewKindFor({ type: 'message/rfc822', name: 'fwd.eml' })).toBe('eml');
    expect(previewKindFor({ type: 'text/html', name: 'a.html' })).toBe('none');
    expect(previewKindFor({ type: 'image/svg+xml', name: 'a.svg' })).toBe('none');
    expect(previewKindFor({ type: 'application/zip', name: 'a.zip' })).toBe('none');
    expect(isReportPart('message/delivery-status')).toBe(true);
    expect(isRfc822Attachment({ type: 'application/octet-stream', name: 'x.eml' })).toBe(true);
  });
});

describe('buildForwardAsAttachmentPayload', () => {
  const email = {
    id: 'e1', threadId: 't1', mailboxIds: {}, keywords: {}, size: 1234,
    receivedAt: '2026-03-04T10:00:00Z', subject: 'Invoice', blobId: 'blob-1', hasAttachment: false,
    from: [{ email: 'a@b.co', name: 'A' }], to: [{ email: 'me@x.co' }],
  } as Email;

  it('references the blob with a {date}-{subject}.eml name and a Fwd: subject', () => {
    const p = buildForwardAsAttachmentPayload(email, 'Fwd:', { template: '{from}-{to}', lowercase: true });
    expect(p?.subject).toBe('Fwd: Invoice');
    expect(p?.attachment).toMatchObject({ blobId: 'blob-1', type: 'message/rfc822', size: 1234 });
    expect(p?.attachment.name).toMatch(/^2026-03-04.*-invoice\.eml$/);
    expect(p?.attachment.name).not.toContain('a@b.co');
  });

  it('returns null without a blob and leaves an empty subject alone', () => {
    expect(buildForwardAsAttachmentPayload({ ...email, blobId: undefined }, 'Fwd:')).toBeNull();
    expect(buildForwardAsAttachmentPayload({ ...email, subject: undefined }, 'Fwd:')?.subject).toBe('');
  });
});
