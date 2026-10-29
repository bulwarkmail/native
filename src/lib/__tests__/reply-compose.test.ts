import { describe, it, expect } from 'vitest';
import type { Email } from '../../api/types';
import { replyComposeParams } from '../reply-compose';

const source = {
  id: 'm1',
  threadId: 't1',
  mailboxIds: {},
  keywords: {},
  size: 1,
  receivedAt: '2026-10-14T10:00:00Z',
  subject: 'Hello',
  from: [{ name: 'Petra', email: 'petra@example.net' }],
  textBody: [{ partId: '1', type: 'text/plain' }],
  bodyValues: { 1: { value: 'Please confirm.' } },
} as unknown as Email;

describe('replyComposeParams', () => {
  it('carries the text typed in quick reply into the composer', () => {
    const params = replyComposeParams('reply', source, undefined, 'Got it, thanks!');
    expect(params?.prefillBody).toBe('Got it, thanks!');
    expect(params?.replyTo?.from.email).toBe('petra@example.net');
  });

  it('adds nothing when nothing was typed', () => {
    expect(replyComposeParams('reply', source)?.prefillBody).toBeUndefined();
    expect(replyComposeParams('reply', source, undefined, '   ')?.prefillBody).toBeUndefined();
  });
});

describe('replyComposeParams: quoted inline images', () => {
  const quotedImage = { blobId: 'b-img', type: 'image/png', name: 'logo.png', disposition: 'inline', cid: '<logo@x>' };
  const unusedInline = { blobId: 'b-sig', type: 'image/png', name: 'sig.png', disposition: 'inline', cid: 'sig@x' };
  const file = { blobId: 'b-pdf', type: 'application/pdf', name: 'report.pdf', disposition: 'attachment' };
  const withImage = {
    ...source,
    htmlBody: [{ partId: '2', type: 'text/html' }],
    textBody: [{ partId: '1', type: 'text/plain' }],
    bodyValues: { 1: { value: 'Hi' }, 2: { value: '<p>Hi <img src="cid:logo@x"></p>' } },
    attachments: [quotedImage, unusedInline, file],
  } as unknown as Email;

  it('hands a reply the image its quote embeds and nothing else', () => {
    expect(replyComposeParams('reply', withImage)?.replyTo?.attachments).toEqual([quotedImage]);
    expect(replyComposeParams('reply', source)?.replyTo?.attachments).toBeUndefined();
  });

  it('hands a forward the quoted image and the files, not unused inline parts', () => {
    expect(replyComposeParams('forward', withImage)?.replyTo?.attachments).toEqual([quotedImage, file]);
  });
});
