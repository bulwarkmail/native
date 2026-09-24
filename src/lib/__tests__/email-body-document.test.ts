import { describe, it, expect, beforeEach } from 'vitest';
import { bodyDocument, buildBodyDocument, clearBodyDocuments, type BodyDocumentInput } from '../email-body-document';

function input(over: Partial<BodyDocumentInput> = {}): BodyDocumentInput {
  return {
    key: '|e1',
    rawHtml: '<p>Hello <img src="https://tracker.example/p.gif"></p>',
    text: null,
    emptyLabel: '(No body content available)',
    blockRemoteImages: true,
    cidMap: {},
    isDark: false,
    messageSpacing: 'auto',
    plainTextFont: 'sans',
    quoteLabels: { show: 'Show quoted text', hide: 'Hide quoted text' },
    ...over,
  };
}

beforeEach(() => {
  clearBodyDocuments();
});

describe('bodyDocument', () => {
  it('builds a mounted-again body only once', () => {
    const first = bodyDocument(input());
    // A remount passes equal values in new objects (a fresh empty cid map).
    const again = bodyDocument(input({ cidMap: {}, quoteLabels: { show: 'Show quoted text', hide: 'Hide quoted text' } }));

    expect(again).toBe(first);
    expect(first.isHtml).toBe(true);
    expect(first.blockedExternal).toBe(true);
  });

  it('matches what building it directly gives', () => {
    expect(bodyDocument(input())).toEqual(buildBodyDocument(input()));
    const text = input({ rawHtml: null, text: 'Hi\n\n> quoted' });
    expect(bodyDocument(text)).toEqual(buildBodyDocument(text));
    expect(bodyDocument(text).isHtml).toBe(false);
    const empty = input({ rawHtml: null, text: '' });
    expect(bodyDocument(empty).html).toContain('(No body content available)');
  });

  it('rebuilds when a setting or the source changes', () => {
    const first = bodyDocument(input());

    expect(bodyDocument(input({ isDark: true }))).not.toBe(first);
    expect(bodyDocument(input({ blockRemoteImages: false }))).not.toBe(first);
    expect(bodyDocument(input({ rawHtml: '<p>Other</p>' })).html).toContain('Other');
    expect(bodyDocument(input({ cidMap: { a: 'data:image/png;base64,AA' } }))).not.toBe(first);
  });

  it('keeps messages apart by key', () => {
    const a = bodyDocument(input({ key: '|e1' }));
    const b = bodyDocument(input({ key: 'group|e1' }));
    expect(b).not.toBe(a);
    expect(bodyDocument(input({ key: '|e1' }))).toBe(a);
  });

  it('forgets the least recently used documents', () => {
    const first = bodyDocument(input({ key: '|m0' }));
    for (let i = 1; i <= 10; i++) bodyDocument(input({ key: `|m${i}` }));
    expect(bodyDocument(input({ key: '|m0' }))).not.toBe(first);
  });
});
