import { describe, it, expect } from 'vitest';
import { shareAttachments } from '../share-intent';

describe('shareAttachments', () => {
  it('uses the display name, type and size the providing app reported', () => {
    expect(shareAttachments({
      uris: ['content://media/external/images/media/1000000027'],
      mimeTypes: ['image/png'],
      names: ['Screenshot_20260924.png'],
      sizes: [48213],
    })).toEqual([{
      uri: 'content://media/external/images/media/1000000027',
      name: 'Screenshot_20260924.png',
      type: 'image/png',
      size: 48213,
    }]);
  });

  it('falls back to the decoded last URI segment and leaves an unknown size out', () => {
    const [a] = shareAttachments({
      uris: ['content://com.example.files/share/Quarterly%20report.pdf'],
      mimeTypes: ['application/pdf'],
      names: [''],
      sizes: [-1],
    });
    expect(a).toEqual({
      uri: 'content://com.example.files/share/Quarterly%20report.pdf',
      name: 'Quarterly report.pdf',
      type: 'application/pdf',
    });
  });

  it('treats a missing or wildcard MIME type as a generic binary', () => {
    const list = shareAttachments({
      uris: ['content://a/1', 'content://a/2'],
      mimeTypes: ['image/*', ''],
    });
    expect(list.map((a) => a.type)).toEqual(['application/octet-stream', 'application/octet-stream']);
  });

  it('keeps names, types and sizes aligned for multiple files', () => {
    const list = shareAttachments({
      uris: ['content://a/1', 'content://a/2'],
      mimeTypes: ['image/jpeg', 'video/mp4'],
      names: ['one.jpg', 'two.mp4'],
      sizes: [10, 20],
    });
    expect(list.map((a) => [a.name, a.type, a.size])).toEqual([
      ['one.jpg', 'image/jpeg', 10],
      ['two.mp4', 'video/mp4', 20],
    ]);
  });
});
