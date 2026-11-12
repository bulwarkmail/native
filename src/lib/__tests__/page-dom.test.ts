// The scripts the mail view injects never take a part of the page by a name
// a mail's element can carry too (<img name="body">, <div id="__rnZoom">).
// What a real page does with such a mail is checked in Chromium outside this
// suite; here the helpers are run against a stand-in for that shadowing, and
// the text of every injected script is pinned.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PAGE_DOM_SOURCE } from '../page-dom';
import { buildQuoteCollapseScript } from '../quote-collapse';
import { buildPauseAnimatedImagesScript } from '../mail-motion';
import { buildEmailDarkModeScript } from '../email-dark-mode';

interface PageDom {
  pagePart: (doc: object, name: string) => unknown;
  pageCall: (doc: object, name: string, args: unknown[]) => unknown;
  pageGlobal: (win: object, name: string) => unknown;
  pageMarked: (doc: object, name: string) => boolean;
  pageOnce: (doc: object, name: string) => boolean;
}

function helpers(DocumentCtor: unknown): PageDom {
  return new Function(
    'Document',
    `${PAGE_DOM_SOURCE}; return { pagePart, pageCall, pageGlobal, pageMarked, pageOnce };`,
  )(DocumentCtor) as PageDom;
}

// A document whose own properties are what named elements put there, over
// the prototype's real getters and methods.
function shadowedDocument() {
  const realBody = { tagName: 'BODY' };
  const realRoot = { tagName: 'HTML' };
  class FakeDocument {}
  Object.defineProperty(FakeDocument.prototype, 'body', { get: () => realBody });
  Object.defineProperty(FakeDocument.prototype, 'documentElement', { get: () => realRoot });
  (FakeDocument.prototype as unknown as Record<string, unknown>).createElement = function (this: unknown, tag: string) {
    return { tagName: tag.toUpperCase(), ownerDocument: this };
  };
  const doc = Object.create(FakeDocument.prototype) as Record<string, unknown>;
  const img = { tagName: 'IMG' };
  for (const name of ['body', 'documentElement', 'createElement']) Object.defineProperty(doc, name, { value: img });
  return { FakeDocument, doc, realBody, realRoot, img };
}

describe('the page helpers', () => {
  it('read the document through its prototype, past an element named like the property', () => {
    const { FakeDocument, doc, realBody, realRoot } = shadowedDocument();
    const dom = helpers(FakeDocument);
    expect(dom.pagePart(doc, 'body')).toBe(realBody);
    expect(dom.pagePart(doc, 'documentElement')).toBe(realRoot);
    expect(dom.pageCall(doc, 'createElement', ['div'])).toEqual({ tagName: 'DIV', ownerDocument: doc });
  });

  it('read a stand-in document without Document directly', () => {
    const dom = helpers(undefined);
    const body = { tagName: 'BODY' };
    expect(dom.pagePart({ body }, 'body')).toBe(body);
    expect(dom.pageCall({ make: (x: string) => `made ${x}` }, 'make', ['it'])).toBe('made it');
  });

  it('take the scripts\' own values from window only, not an element with that id', () => {
    const dom = helpers(undefined);
    const named = Object.create({ __rnZoom: { tagName: 'DIV' }, __rnReport: { tagName: 'DIV' } });
    expect(dom.pageGlobal(named, '__rnZoom')).toBeUndefined();
    expect(dom.pageGlobal(named, '__rnReport')).toBeUndefined();
    named.__rnZoom = { scale: 1 };
    expect(dom.pageGlobal(named, '__rnZoom')).toEqual({ scale: 1 });
  });

  it('mark a document as done with a symbol no element can name', () => {
    const dom = helpers(undefined);
    const doc: Record<string, unknown> = { 'bulwark.quoteCollapse': { tagName: 'IMG' }, __rnImgFixupDone: { tagName: 'IMG' } };
    expect(dom.pageMarked(doc, 'quoteCollapse')).toBe(false);
    expect(dom.pageOnce(doc, 'quoteCollapse')).toBe(true);
    expect(dom.pageMarked(doc, 'quoteCollapse')).toBe(true);
    expect(dom.pageOnce(doc, 'quoteCollapse')).toBe(false);
  });
});

// The component's scripts as the view injects them (the same extraction the
// Chromium check uses).
function componentScript(name: string): string {
  const src = fs.readFileSync(path.resolve(__dirname, '../../components/EmailBodyView.tsx'), 'utf8');
  const m = new RegExp(`const ${name} = \`([\\s\\S]*?)\`;\\r?\\n`).exec(src);
  if (!m) throw new Error(`script not found: ${name}`);
  return new Function('PAGE_DOM_SOURCE', `return \`${m[1]}\`;`)(PAGE_DOM_SOURCE) as string;
}

const SCRIPTS: Array<[string, string]> = [
  ['quote collapse', buildQuoteCollapseScript({ show: 'Show', hide: 'Hide' })],
  ['pause animated images', buildPauseAnimatedImagesScript({ play: 'Play', pause: 'Pause' })],
  ['dark recolour', buildEmailDarkModeScript({ remoteContentAllowed: false })],
  ['image fix-ups', componentScript('IMG_FIXUP_SCRIPT')],
  ['height reporter', componentScript('HEIGHT_REPORTER')],
  ['swipe detector', componentScript('SWIPE_DETECTOR')],
  ['pinch zoom', componentScript('PINCH_ZOOM')],
];

describe('the injected scripts', () => {
  it.each(SCRIPTS)('%s takes nothing of the page by a name a mail can use', (_name, script) => {
    // A property or method of document, which <img name="..."> stands in for.
    expect(script).not.toMatch(/\bdoc(?:ument)?\.(?!__)[A-Za-z]/);
    expect(script).not.toMatch(/getElementById\(/);
    // A flag or a hook read from document or window by name.
    expect(script).not.toMatch(/\bdoc(?:ument)?\.__rn/);
    expect(script).not.toMatch(/(?:if \(|\(|&&\s*|\|\|\s*|!)window\.__rn/);
    expect(script).not.toMatch(/=\s*window\.__rn\w+\s*\|\|/);
  });

  it('builds the wrapper rather than looking one up', () => {
    const reporter = componentScript('HEIGHT_REPORTER');
    expect(reporter).toMatch(/pageCall\(document, 'createElement', \['div'\]\)/);
    expect(reporter).not.toMatch(/__rn_email_body_wrap__/);
  });
});
