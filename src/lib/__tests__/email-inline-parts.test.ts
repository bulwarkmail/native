import { describe, it, expect } from 'vitest';
import { inlineBodyParts, withInlineBodyParts } from '../email-inline-parts';

const image = { partId: '4', blobId: 'b-img', type: 'image/png', disposition: 'inline', cid: 'x@y' };
const text = { partId: '2', blobId: 'b-text', type: 'text/plain' };
const html = { partId: '3', blobId: 'b-html', type: 'text/html' };

describe('inlineBodyParts', () => {
  it('takes non-text body parts once, in body order', () => {
    const audio = { partId: '5', blobId: 'b-audio', type: 'audio/ogg' };
    expect(inlineBodyParts({ attachments: [], textBody: [text, image, audio], htmlBody: [html, image] }))
      .toEqual([image, audio]);
  });

  it('skips parts already in attachments and text parts in either list', () => {
    expect(inlineBodyParts({ attachments: [image], textBody: [text, image], htmlBody: [html, image] })).toEqual([]);
    expect(inlineBodyParts({ textBody: [text], htmlBody: [html, { partId: '6', type: 'TEXT/calendar', blobId: 'c' }] })).toEqual([]);
  });

  it('returns the same object when there is nothing to add', () => {
    const email = { attachments: [image], textBody: [text], htmlBody: [html] };
    expect(withInlineBodyParts(email)).toBe(email);
    const on10 = { attachments: [], textBody: [text, image], htmlBody: [html, image] };
    expect(withInlineBodyParts(on10).attachments).toEqual([image]);
  });
});
