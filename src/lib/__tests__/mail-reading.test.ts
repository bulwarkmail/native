import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildMailTextSizeScript, mailBaseFontPx, mailTextFactor } from '../mail-reading';
import { buildBodyDocument } from '../email-body-document';

// The mail body was fixed at 14 px whatever the app's text size or the
// system font size said (webmail c07ba1a37 scales it).

const base = {
  key: 'k', emptyLabel: '-', blockRemoteImages: false, cidMap: {}, isDark: false,
  messageSpacing: 'auto' as const, plainTextFont: 'sans' as const, quoteLabels: { show: 's', hide: 'h' },
};

describe('mail text size', () => {
  it('multiplies the app text size by the system font scale, within bounds', () => {
    expect(mailTextFactor(1, 1)).toBe(1);
    expect(mailTextFactor(1.14, 1.3)).toBe(1.48);
    expect(mailTextFactor(1, 0)).toBe(1);
    expect(mailTextFactor(2, 3)).toBe(3);
    expect(mailBaseFontPx(1.5)).toBe(21);
  });

  it('sizes a plain-text body by the factor', () => {
    expect(buildBodyDocument({ ...base, rawHtml: null, text: 'hello' }).html).toMatch(/font-size: 14px;/);
    expect(buildBodyDocument({ ...base, rawHtml: null, text: 'hello', textFactor: 1.5 }).html).toMatch(/font-size: 21px;/);
  });

  it('scales every element of an HTML body once, line heights in px included', () => {
    expect(buildMailTextSizeScript(1)).toBe('');
    const writes: Array<[string, string, string]> = [];
    const attrs = new Set<string>();
    const el = (tag: string, fontSize: string, lineHeight: string, inSvg = false) => ({
      tagName: tag,
      computed: { fontSize, lineHeight },
      closest: (sel: string) => (sel === 'svg' && inSvg ? {} : null),
      style: { setProperty: (prop: string, value: string) => writes.push([tag, prop, value]) },
    });
    const kids = [el('P', '16px', '24px'), el('SPAN', '12px', 'normal'), el('IMG', '14px', 'normal'), el('TEXT', '10px', 'normal', true)];
    const body = {
      ...el('BODY', '14px', '22.4px'),
      hasAttribute: (a: string) => attrs.has(a),
      setAttribute: (a: string) => attrs.add(a),
      querySelectorAll: () => kids,
    };
    const window = { getComputedStyle: (e: { computed: unknown }) => e.computed };
    const run = () => new Function('document', 'window', buildMailTextSizeScript(1.5))({ body }, window);
    run();
    expect(writes).toEqual([
      ['BODY', 'font-size', '21px'], ['BODY', 'line-height', '33.6px'],
      ['P', 'font-size', '24px'], ['P', 'line-height', '36px'],
      ['SPAN', 'font-size', '18px'],
    ]);
    // The body view injects its scripts again after load: no second pass.
    run();
    expect(writes).toHaveLength(5);
  });

  it('scales the text of a mail that has an element named body, and calls only the page\'s own height hook', () => {
    // The page's real body sits behind Document.prototype; <img name="body">
    // is what document.body returns, and an element with id __rnReport is
    // window.__rnReport until the height reporter sets its own.
    const writes: string[] = [];
    const realBody = {
      tagName: 'BODY',
      computed: { fontSize: '10px', lineHeight: 'normal' },
      closest: () => null,
      querySelectorAll: () => [],
      style: { setProperty: (prop: string, value: string) => writes.push(`${prop}: ${value}`) },
    };
    let pageBody: object = realBody;
    class FakeDocument {}
    Object.defineProperty(FakeDocument.prototype, 'body', { get: () => pageBody });
    const named = { tagName: 'IMG', querySelectorAll: () => { throw new Error('read the named element'); } };
    const doc = Object.create(FakeDocument.prototype);
    Object.defineProperty(doc, 'body', { value: named });
    const timers: unknown[] = [];
    const run = (window: object) => new Function('document', 'window', 'Document', 'setTimeout', buildMailTextSizeScript(1.3))(
      doc, window, FakeDocument, (fn: unknown) => timers.push(fn),
    );
    const getComputedStyle = (e: { computed: unknown }) => e.computed;
    run(Object.assign(Object.create({ __rnReport: { tagName: 'A' } }), { getComputedStyle }));
    expect(writes).toEqual(['font-size: 13px']);
    expect(timers, 'an element with the hook\'s id is never handed to setTimeout').toEqual([]);
    // The height reporter's own hook, on another document.
    const report = () => undefined;
    pageBody = { tagName: 'BODY', computed: realBody.computed, closest: () => null, querySelectorAll: () => [], style: { setProperty: () => undefined } };
    run({ getComputedStyle, __rnReport: report });
    expect(timers).toEqual([report]);
  });

  it('is wired into the body view, with Android text zoom held at 100', () => {
    const view = fs.readFileSync(path.resolve(__dirname, '../../components/EmailBodyView.tsx'), 'utf8');
    expect(view).toMatch(/mailTextFactor\(dyn\.body\.fontSize \/ typography\.body\.fontSize, PixelRatio\.getFontScale\(\)\)/);
    expect(view).toMatch(/buildMailTextSizeScript\(textFactor\)/);
    expect(view).toMatch(/textZoom=\{100\}/);
  });
});
