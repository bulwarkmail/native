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
import { buildMailTextSizeScript } from '../mail-reading';
import { buildEditorHtml } from '../editor-html';
import { LIGHT_COLORS } from '../../theme/tokens';

interface PageDom {
  pagePart: (doc: object, name: string) => unknown;
  pageCall: (doc: object, name: string, args: unknown[]) => unknown;
  nodePart: (node: object, name: string) => unknown;
  nodeCall: (node: object, name: string, args: unknown[]) => unknown;
  pageGlobal: (win: object, name: string) => unknown;
  pageMarked: (doc: object, name: string) => boolean;
  pageOnce: (doc: object, name: string) => boolean;
}

function helpers(DocumentCtor: unknown, ctors: { Element?: unknown; Node?: unknown } = {}): PageDom {
  return new Function(
    'Document', 'Element', 'Node',
    `${PAGE_DOM_SOURCE}; return { pagePart, pageCall, nodePart, nodeCall, pageGlobal, pageMarked, pageOnce };`,
  )(DocumentCtor, ctors.Element, ctors.Node) as PageDom;
}

// A <form> whose own properties are what its named inputs put there
// (<input name="closest">), over Element's and Node's real ones.
function shadowedForm() {
  class FakeNode {
    constructor(public parent: FakeNode | null = null) {}
    get parentElement(): FakeNode | null { return this.parent; }
  }
  class FakeElement extends FakeNode {
    constructor(public tag: string, parent: FakeNode | null = null) { super(parent); }
    closest(tag: string): FakeElement | null {
      for (let e: FakeNode | null = this; e; e = e.parent) if (e instanceof FakeElement && e.tag === tag) return e;
      return null;
    }
    matches(tag: string): boolean { return this.tag === tag; }
  }
  const quote = new FakeElement('blockquote');
  const form = new FakeElement('form', quote);
  const input = { tagName: 'INPUT' };
  for (const name of ['closest', 'matches', 'parentElement']) Object.defineProperty(form, name, { value: input });
  return { FakeNode, FakeElement, quote, form, input };
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

  it('read a mail element through Element and Node, past a form input named like the method', () => {
    const { FakeNode, FakeElement, quote, form } = shadowedForm();
    const dom = helpers(undefined, { Element: FakeElement, Node: FakeNode });
    expect(dom.nodeCall(form, 'closest', ['blockquote'])).toBe(quote);
    expect(dom.nodeCall(form, 'matches', ['form'])).toBe(true);
    expect(dom.nodePart(form, 'parentElement')).toBe(quote);
    // Something that is no element, like the script's own objects, is read directly.
    expect(dom.nodeCall({ make: (x: string) => `made ${x}` }, 'make', ['it'])).toBe('made it');
    expect(dom.nodePart({ nodeType: 3 }, 'nodeType')).toBe(3);
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
  ['text size', buildMailTextSizeScript(1.3)],
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

  it('quote collapse reads the mail\'s elements only through nodePart and nodeCall', () => {
    // A <form> with <input name="closest"> stands in for form.closest the way
    // <img name="body"> does for document.body. Only the toggle button the
    // script makes itself is used directly.
    const script = buildQuoteCollapseScript({ show: 'Show', hide: 'Hide' }).replace(PAGE_DOM_SOURCE, '');
    const members = 'closest|matches|hasAttribute|getAttribute|setAttribute|removeAttribute|compareDocumentPosition'
      + '|querySelector|querySelectorAll|insertBefore|appendChild|parentElement|parentNode|nextElementSibling'
      + '|style|tagName|nodeType|nodeValue|addEventListener|textContent';
    const direct = [...script.matchAll(new RegExp(`\\b(\\w+)\\.(${members})\\b`, 'g'))]
      .map((m) => m[0])
      .filter((use) => !use.startsWith('button.'));
    expect(direct).toEqual([]);
  });

  it('the compose editor makes the quote toggle and puts it on the body with the helpers', () => {
    // The editor page holds the quoted mail once its initial content is in.
    const html = buildEditorHtml({ initialHtml: '<p><br></p>', placeholder: '', c: LIGHT_COLORS, collapseQuote: true });
    const block = /if \(COLLAPSE_QUOTE && topQuote\(\)\) \{[\s\S]*?\n {2}\}\n/.exec(html)?.[0] ?? '';
    expect(block).toMatch(/pageCall\(document, 'createElement', \['button'\]\)/);
    expect(block).toMatch(/pagePart\(document, 'body'\)\.appendChild\(quoteToggle\)/);
    expect(block).not.toMatch(/\bdocument\.[A-Za-z]/);
  });

  it('builds the wrapper rather than looking one up', () => {
    const reporter = componentScript('HEIGHT_REPORTER');
    expect(reporter).toMatch(/pageCall\(document, 'createElement', \['div'\]\)/);
    expect(reporter).not.toMatch(/__rn_email_body_wrap__/);
  });
});
