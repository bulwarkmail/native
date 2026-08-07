import { describe, it, expect } from 'vitest';
import { draftToComposeInit, rewriteCidSrcToDataUrls } from '../draft-compose';
import type { Email } from '../../api/types';

function makeDraft(overrides: Partial<Email> = {}): Email {
  return {
    id: 'e-1',
    threadId: 't-1',
    mailboxIds: { 'drafts-mb': true },
    keywords: { $draft: true },
    size: 1000,
    receivedAt: '2026-08-01T10:00:00Z',
    hasAttachment: false,
    ...overrides,
  };
}

describe('draftToComposeInit', () => {
  it('maps recipients, subject and the html body', () => {
    const init = draftToComposeInit(makeDraft({
      to: [{ email: 'you@example.com', name: 'You' }],
      cc: [{ email: 'cc@example.com' }],
      bcc: [{ email: 'hidden@example.com' }],
      subject: 'WIP',
      htmlBody: [{ partId: 'html', type: 'text/html' }],
      bodyValues: { html: { value: '<p>half-written</p>' } },
    }));

    expect(init.to).toEqual([{ email: 'you@example.com', name: 'You' }]);
    expect(init.cc).toEqual([{ email: 'cc@example.com' }]);
    expect(init.bcc).toEqual([{ email: 'hidden@example.com' }]);
    expect(init.subject).toBe('WIP');
    expect(init.bodyHtml).toBe('<p>half-written</p>');
  });

  it('escapes a text-only body into html', () => {
    const init = draftToComposeInit(makeDraft({
      textBody: [{ partId: 'text', type: 'text/plain' }],
      bodyValues: { text: { value: 'line one\nwith <angle> & amp' } },
    }));

    expect(init.bodyHtml).toBe('line one<br>with &lt;angle&gt; &amp; amp');
  });

  it('strips dangerous tags from the stored html body', () => {
    const init = draftToComposeInit(makeDraft({
      htmlBody: [{ partId: 'html', type: 'text/html' }],
      bodyValues: { html: { value: '<p>ok</p><script>alert(1)</script>' } },
    }));

    expect(init.bodyHtml).not.toContain('<script>');
    expect(init.bodyHtml).toContain('<p>ok</p>');
  });

  it('classifies attachments and unwraps cid brackets', () => {
    const init = draftToComposeInit(makeDraft({
      attachments: [
        { blobId: 'b-1', type: 'application/pdf', name: 'doc.pdf', size: 42, disposition: 'attachment' },
        { blobId: 'b-2', type: 'image/png', name: 'pic.png', size: 7, disposition: 'inline', cid: '<img-1@local>' },
      ],
    }));

    expect(init.attachments).toEqual([
      { blobId: 'b-1', type: 'application/pdf', name: 'doc.pdf', size: 42, cid: undefined, inline: false },
      { blobId: 'b-2', type: 'image/png', name: 'pic.png', size: 7, cid: 'img-1@local', inline: true },
    ]);
  });

  it('keeps reply threading headers', () => {
    const init = draftToComposeInit(makeDraft({
      inReplyTo: ['<msg-1@example.com>'],
      references: ['<msg-0@example.com>', '<msg-1@example.com>'],
    }));

    expect(init.inReplyTo).toBe('<msg-1@example.com>');
    expect(init.references).toBe('<msg-0@example.com> <msg-1@example.com>');
  });

  it('defaults everything on an empty draft', () => {
    const init = draftToComposeInit(makeDraft());

    expect(init.to).toEqual([]);
    expect(init.subject).toBe('');
    expect(init.bodyHtml).toBe('');
    expect(init.attachments).toEqual([]);
  });
});

describe('rewriteCidSrcToDataUrls', () => {
  it('swaps cid: srcs for data urls and stamps data-cid', () => {
    const html = '<p>x</p><img alt="a" src="cid:img-1@local" width="10">';
    const out = rewriteCidSrcToDataUrls(html, { 'img-1@local': 'data:image/png;base64,AA==' });

    expect(out).toBe('<p>x</p><img alt="a" src="data:image/png;base64,AA==" data-cid="img-1@local" width="10">');
  });

  it('leaves images whose cid was not hydrated untouched', () => {
    const html = '<img src="cid:missing@local">';
    expect(rewriteCidSrcToDataUrls(html, {})).toBe(html);
  });

  it('is a no-op on html without cid references', () => {
    const html = '<p>plain</p><img src="https://example.com/x.png">';
    expect(rewriteCidSrcToDataUrls(html, { any: 'data:x' })).toBe(html);
  });
});
