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

  it('draws a plain-text body in the reading font and rebuilds when it changes', () => {
    const text = input({ rawHtml: null, text: 'Hello' });
    const plain = bodyDocument(text);
    const lexend = bodyDocument({ ...text, appFont: 'lexend' });
    expect(lexend).not.toBe(plain);
    expect(lexend.html).toContain('font-family: "Lexend"');
    expect(plain.html).not.toContain('Lexend');
  });

  it('takes the dark theme background as the mail canvas and rebuilds when it changes', () => {
    const nord = bodyDocument(input({ isDark: true, darkCanvas: '#2e3440' }));
    expect(nord.html).toContain('background-color: rgb(46, 52, 64) !important');
    const mocha = bodyDocument(input({ isDark: true, darkCanvas: '#1e1e2e' }));
    expect(mocha).not.toBe(nord);
    expect(mocha.html).toContain('background-color: rgb(30, 30, 46) !important');
  });

  it('puts an empty message on the dark theme background too', () => {
    const empty = bodyDocument(input({ rawHtml: null, text: null, isDark: true, darkCanvas: '#2e3440' }));
    expect(empty.html).toContain('(No body content available)');
    expect(empty.html).toContain('background-color: rgb(46, 52, 64) !important');
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
