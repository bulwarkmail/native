// The app's stand-in for DOMParser (html-parser.ts): the tree it builds must
// answer extract.ts's DOM calls the way a browser document does.
import { describe, expect, it } from 'vitest';
import { decodeCharacterReferences, parseHtmlDocument } from '../html-parser';

const parse = (html: string) => parseHtmlDocument(html);
const tags = (nodes: ArrayLike<Element>) => Array.from(nodes).map((el) => el.tagName.toLowerCase());

describe('parseHtmlDocument', () => {
  it('nests elements, closes void elements and ignores stray end tags', () => {
    const doc = parse('<div id="a"><span>x<br>y</span></em><img src="i"><p>z</div><i>after</i>');
    const div = doc.getElementById('a')!;
    expect(tags(div.querySelectorAll('*' as string))).toEqual(['span', 'br', 'img', 'p']);
    expect(doc.querySelector('i')!.parentElement).toBeNull();
    expect(div.textContent).toBe('xyz');
  });

  it('closes the elements HTML closes for you', () => {
    const doc = parse('<ul><li id="one">1<li id="two">2</ul><p id="p">para<div id="d">block</div><table><tr><td id="c1">a<td id="c2">b<tr><td id="c3">c</table>');
    expect(doc.getElementById('two')!.parentElement!.tagName).toBe('UL');
    expect(doc.getElementById('one')!.textContent).toBe('1');
    // A block start tag ends the open paragraph.
    expect(doc.getElementById('d')!.parentElement).toBeNull();
    expect(doc.getElementById('c2')!.parentElement).toBe(doc.getElementById('c1')!.parentElement);
    expect(doc.getElementById('c3')!.parentElement).not.toBe(doc.getElementById('c1')!.parentElement);
  });

  it('reads a script verbatim up to its end tag, markup and entities included', () => {
    const json = '{"name":"</div><b>&amp;</b>","x":1}';
    const doc = parse(`<div><script type="application/ld+json">${json}</script><p id="after">ok</p></div>`);
    const script = doc.querySelector('script')!;
    expect(script.textContent).toBe(json);
    expect(doc.querySelectorAll('b')).toHaveLength(0);
    expect(doc.getElementById('after')!.parentElement!.tagName).toBe('DIV');
  });

  it('decodes character references in text and attribute values, as the browser does', () => {
    const doc = parse('<a id="l" href="https://x.example/?a=1&amp;b=2&copy=3" title="&quot;M&uuml;ller&quot;">Caf&eacute; &#8364;5 &#x1F600; &copy2026 &unknown;</a>');
    const link = doc.getElementById('l')!;
    expect(link.getAttribute('href')).toBe('https://x.example/?a=1&b=2&copy=3');
    expect(link.getAttribute('title')).toBe('"Müller"');
    expect(link.textContent).toBe('Café €5 \u{1F600} ©2026 &unknown;');
    expect(decodeCharacterReferences('&#128;&#0;')).toBe('€�');
  });

  it('keeps the first of repeated attributes and matches names case-insensitively', () => {
    const el = parse('<div ItemScope itemtype="https://schema.org/Order" itemtype="x"></div>').querySelector('div')!;
    expect(el.hasAttribute('itemscope')).toBe(true);
    expect(el.getAttribute('ITEMTYPE')).toBe('https://schema.org/Order');
  });

  it('answers closest and querySelectorAll for the selectors extract.ts uses', () => {
    const doc = parse('<!DOCTYPE html><div class="x gmail_quote"><section><span id="in">a</span></section></div><span id="out">b</span>');
    const quoted = 'blockquote, .gmail_quote, .moz-forward-container, #appendonsend, #divRplyFwdMsg';
    expect(doc.getElementById('in')!.closest(quoted)!.tagName).toBe('DIV');
    expect(doc.getElementById('out')!.closest(quoted)).toBeNull();
    expect(tags(doc.querySelectorAll('[id]'))).toEqual(['span', 'span']);
    expect(() => doc.querySelectorAll('div span')).toThrow(/unsupported selector/);
  });

  it('matches classes case-insensitively only in a document without a doctype (quirks mode)', () => {
    expect(parse('<div class="Gmail_Quote"><i>q</i></div>').querySelector('i')!.closest('.gmail_quote')).not.toBeNull();
    expect(parse('<!doctype html><div class="Gmail_Quote"><i>q</i></div>').querySelector('i')!.closest('.gmail_quote')).toBeNull();
  });

  it('orders elements like compareDocumentPosition', () => {
    const doc = parse('<div id="sep"><b id="inside">x</b></div><p id="after">y</p><p id="before-not">z</p>');
    const sep = doc.getElementById('sep')!;
    const FOLLOWING = 4;
    expect(sep.compareDocumentPosition(doc.getElementById('after')!) & FOLLOWING).toBeTruthy();
    expect(sep.compareDocumentPosition(doc.getElementById('inside')!) & FOLLOWING).toBeTruthy();
    expect(doc.getElementById('after')!.compareDocumentPosition(sep) & FOLLOWING).toBeFalsy();
  });

  it('drops comments, so markup inside one is not read', () => {
    const doc = parse('<!-- <script type="application/ld+json">{}</script> --><p>x</p>');
    expect(doc.querySelectorAll('script')).toHaveLength(0);
  });

  it('does not enter template content', () => {
    expect(parse('<template><div itemscope></div></template>').querySelectorAll('[itemscope]')).toHaveLength(0);
  });
});
