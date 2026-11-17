// The dark-mode recolour pass (webmail lib/email-dark-mode.ts). The pass is
// JavaScript source injected into the mail WebView; these tests evaluate that
// same source. The colour cases are the webmail's
// (lib/__tests__/email-dark-mode.test.ts). The app has no DOM library, so the
// DOM pass runs on a small fake document that answers getComputedStyle the
// way a browser does for the parts the pass reads (inline styles win, colour
// inherits, everything else has its initial value).
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {
  DARK_PENDING_CLASS,
  EMAIL_DARK_MODE_LIB,
  buildEmailDarkModeScript,
  emailColorScheme,
  emailDarkCanvas,
  emailDarkModeCss,
  resolveColorSchemeMedia,
  type EmailDarkModeLib,
  type Rgba,
} from '../email-dark-mode';
import { DARK_COLORS } from '../../theme/tokens';
import { BUILTIN_THEMES } from '../../theme/builtin-themes';

const DM = new Function(`return ${EMAIL_DARK_MODE_LIB}`)()() as EmailDarkModeLib;
const c = (value: string): Rgba => DM.parseComputedColor(value)!;
const lightness = ({ r, g, b }: Rgba) => (r + g + b) / 3;
const apca = (text: Rgba, bg: Rgba) => {
  const y = ({ r, g, b }: Rgba) => 0.2126729 * (r / 255) ** 2.4 + 0.7151522 * (g / 255) ** 2.4 + 0.072175 * (b / 255) ** 2.4;
  const clamp = (v: number) => (v > 0.022 ? v : v + (0.022 - v) ** 1.414);
  const t = clamp(y(text)), s = clamp(y(bg));
  const lc = s > t ? (s ** 0.56 - t ** 0.57) * 1.14 : (s ** 0.65 - t ** 0.62) * 1.14;
  return Math.abs(lc) < 0.1 ? 0 : (Math.abs(lc) - 0.027) * 100;
};
const WHITE = c('rgb(255, 255, 255)');

const CANVASES = ['rgb(10, 10, 10)', 'rgb(46, 52, 64)', 'rgb(30, 30, 46)'];

describe('darkenBackground', () => {
  it.each(CANVASES)('lands white exactly on the surface the mail sits on (%s)', (canvas) => {
    expect(DM.formatColor(DM.darkenBackground(WHITE, c(canvas)))).toBe(canvas);
  });

  it('keeps a light grey page and the white card on it apart', () => {
    const canvas = c('rgb(20, 20, 20)');
    const card = DM.darkenBackground(WHITE, canvas);
    const page = DM.darkenBackground(c('rgb(242, 242, 242)'), canvas);
    expect(DM.contrastRatio(page, card)).toBeGreaterThan(1.1);
    expect(lightness(page)).toBeGreaterThan(lightness(card));
  });

  it('keeps the hue of a light tint', () => {
    const out = DM.darkenBackground(c('rgb(214, 233, 248)'));
    expect(lightness(out)).toBeLessThan(80);
    expect(out.b).toBeGreaterThan(out.r);
  });

  it('dims a bright brand fill in its own hue, and its white label still reads', () => {
    const orange = c('rgb(243, 128, 32)');
    const out = DM.darkenBackground(orange);
    expect(lightness(out)).toBeLessThan(lightness(orange) * 0.7);
    expect(out.r).toBeGreaterThan(out.g);
    expect(out.g).toBeGreaterThan(out.b);
    expect(DM.contrastRatio(WHITE, out)).toBeGreaterThan(4.5);
  });

  it('leaves deep brand colours and dark fills as sent', () => {
    const red = c('rgb(227, 6, 19)');
    const navy = c('rgb(0, 32, 91)');
    expect(DM.darkenBackground(red)).toBe(red);
    expect(DM.darkenBackground(navy)).toBe(navy);
  });

  it('keeps alpha', () => {
    expect(DM.darkenBackground(c('rgba(255, 255, 255, 0.5)')).a).toBe(0.5);
  });
});

describe('adaptTextColor', () => {
  const canvas = c('rgb(20, 20, 20)');

  it('turns body text near white, but not glaring', () => {
    const out = DM.adaptTextColor(c('rgb(0, 0, 0)'), canvas, WHITE);
    expect(DM.contrastRatio(out, canvas)).toBeGreaterThan(11.5);
    expect(out.r).toBeLessThan(235);
  });

  it('keeps secondary greys dimmer than body text, and readable', () => {
    const body = DM.adaptTextColor(c('rgb(34, 34, 34)'), canvas, WHITE);
    const muted = DM.adaptTextColor(c('rgb(120, 120, 120)'), canvas, WHITE);
    expect(lightness(muted)).toBeLessThan(lightness(body));
    expect(DM.contrastRatio(muted, canvas)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps a red link red', () => {
    const out = DM.adaptTextColor(c('rgb(200, 0, 0)'), canvas, WHITE);
    expect(out.r).toBeGreaterThan(out.g + 60);
  });

  it('leaves light text on a kept dark banner alone', () => {
    const navy = c('rgb(0, 32, 91)');
    expect(DM.adaptTextColor(WHITE, navy, navy)).toBe(WHITE);
  });
});

describe('judgeImagePixels', () => {
  const bg = c('rgb(20, 20, 20)');
  const image = (w: number, h: number, px: (x: number, y: number) => [number, number, number, number]) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(px(x, y), (y * w + x) * 4);
    return data;
  };

  it('flips a black logo on a see-through background', () => {
    const logo = image(40, 20, (x, y) => (x > 5 && x < 35 && y > 5 && y < 15 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
    expect(DM.judgeImagePixels(logo, bg)).toBe('flip');
  });

  it('never touches a photo', () => {
    const photo = image(40, 40, (x, y) => [80 + x * 3, 60 + y * 4, 120 + ((x * y) % 90), 255]);
    expect(DM.judgeImagePixels(photo, bg)).toBe('fine');
  });
});

describe('parseComputedColor / formatColor', () => {
  it('reads the forms getComputedStyle returns', () => {
    expect(c('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(c('rgba(1, 2, 3, 0.5)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    expect(c('rgb(1 2 3 / 50%)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
  });

  it('writes rgb() when opaque and rgba() otherwise', () => {
    expect(DM.formatColor({ r: 1.4, g: 2, b: 3, a: 1 })).toBe('rgb(1, 2, 3)');
    expect(DM.formatColor({ r: 1, g: 2, b: 3, a: 0.25 })).toBe('rgba(1, 2, 3, 0.25)');
  });
});

describe('emailDarkCanvas', () => {
  it('reads the forms the theme tokens use', () => {
    expect(emailDarkCanvas('#2e3440')).toEqual({ r: 46, g: 52, b: 64, a: 1 });
    expect(emailDarkCanvas('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(emailDarkCanvas('rgb(30, 30, 46)')).toEqual({ r: 30, g: 30, b: 46, a: 1 });
  });

  it("falls back to the standard dark background for what it can't use", () => {
    const standard = emailDarkCanvas(DARK_COLORS.background);
    for (const bad of [undefined, '', 'red;}</style>', 'rgba(0, 0, 0, 0.5)', '#12345']) {
      expect(emailDarkCanvas(bad)).toEqual(standard);
    }
  });
});

describe('emailDarkModeCss', () => {
  it('shows the canvas while the pass is pending, so nothing flashes white or steps in colour', () => {
    const css = emailDarkModeCss(c('rgb(46, 52, 64)'));
    expect(css).toContain(`html.${DARK_PENDING_CLASS}, html.${DARK_PENDING_CLASS} body { background-color: rgb(46, 52, 64) !important; }`);
    expect(css).toMatch(/html\.bulwark-dark-pending body \{ color: #e6e6e6;/);
    expect(css).not.toContain('#141414');
  });
});

describe('resolveColorSchemeMedia', () => {
  const html = '<style>@media (prefers-color-scheme: dark) { .a { color: white } } @media (prefers-color-scheme:light) { .b {} }</style><p>(prefers-color-scheme: dark)</p>';

  it('turns the dark query on and the light one off in dark mode', () => {
    const out = resolveColorSchemeMedia(html, true);
    expect(out).toContain('@media (min-width: 0px) { .a');
    expect(out).toContain('@media (max-width: 0.001px) { .b');
  });

  it('turns the dark query off in light mode', () => {
    const out = resolveColorSchemeMedia(html, false);
    expect(out).toContain('@media (max-width: 0.001px) { .a');
    expect(out).toContain('@media (min-width: 0px) { .b');
  });

  it('leaves text outside <style> alone', () => {
    expect(resolveColorSchemeMedia(html, true)).toContain('<p>(prefers-color-scheme: dark)</p>');
  });
});

describe('emailColorScheme', () => {
  it('is dark only for a mail with its own dark styles shown dark', () => {
    expect(emailColorScheme(true, true)).toBe('dark');
    expect(emailColorScheme(true, false)).toBe('light');
    expect(emailColorScheme(false, true)).toBe('light');
  });
});

describe('the embedded engine', () => {
  it('evaluates to the shared engine', () => {
    for (const name of ['parseColor', 'darkenBackground', 'adaptTextColor', 'judgeImagePixels', 'flipFilterMatrix', 'apply'] as const) {
      expect(typeof DM[name]).toBe('function');
    }
  });

  it('is plain ES5', () => {
    const file = ts.createSourceFile('engine.js', `(${EMAIL_DARK_MODE_LIB})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const newer: string[] = [];
    const visit = (node: ts.Node) => {
      const k = ts.SyntaxKind;
      if (ts.isCatchClause(node) && !node.variableDeclaration) newer.push('catch without a binding');
      if (ts.isVariableDeclarationList(node) && node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) newer.push('let/const');
      if ([k.ArrowFunction, k.ClassDeclaration, k.ClassExpression, k.TemplateExpression, k.NoSubstitutionTemplateLiteral,
        k.SpreadElement, k.ObjectBindingPattern, k.ArrayBindingPattern, k.ForOfStatement, k.AwaitExpression, k.YieldExpression,
        k.ShorthandPropertyAssignment, k.ComputedPropertyName, k.QuestionDotToken, k.QuestionQuestionToken,
        k.AsteriskAsteriskToken, k.AsteriskAsteriskEqualsToken, k.SpreadAssignment, k.BigIntLiteral, k.AsyncKeyword,
        k.TaggedTemplateExpression, k.QuestionQuestionEqualsToken, k.BarBarEqualsToken, k.AmpersandAmpersandEqualsToken].includes(node.kind)) {
        newer.push(k[node.kind]);
      }
      if (ts.isParameter(node) && node.initializer) newer.push('default parameter');
      if (ts.isMethodDeclaration(node)) newer.push('method shorthand');
      if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.asteriskToken) newer.push('generator');
      if (ts.isNumericLiteral(node) && /^0[bo]|_/i.test(node.getText())) newer.push('numeric literal ' + node.getText());
      if (ts.isRegularExpressionLiteral(node) && /\/[gim]*[suyd][a-z]*$/.test(node.text)) newer.push('regex flag ' + node.text);
      ts.forEachChild(node, visit);
    };
    visit(file);
    expect(newer).toEqual([]);
  });

  it('embeds as a raw string and names no remote address', () => {
    expect(EMAIL_DARK_MODE_LIB).not.toContain('`');
    expect(EMAIL_DARK_MODE_LIB).not.toContain('${');
    expect(EMAIL_DARK_MODE_LIB).not.toMatch(/https?:\/\//);
  });
});

// ─── A fake rendered document ─────────────────────────────────────────────

type Css = Partial<Record<'color' | 'backgroundColor' | 'backgroundImage' | 'border', string>>;

class FakeStyle {
  private props = new Map<string, { value: string; priority: string }>();
  setProperty(name: string, value: string, priority = '') { this.props.set(name, { value, priority }); }
  getPropertyValue(name: string) { return this.props.get(name)?.value ?? ''; }
  getPropertyPriority(name: string) { return this.props.get(name)?.priority ?? ''; }
}

class FakeElement {
  parentElement: FakeElement | null = null;
  children: FakeElement[] = [];
  style = new FakeStyle();
  private classes = new Set<string>();
  classList = {
    remove: (name: string) => { this.classes.delete(name); },
    contains: (name: string) => this.classes.has(name),
    add: (name: string) => { this.classes.add(name); },
  };
  isConnected = true;
  constructor(public tagName: string, public css: Css = {}, public id = '') {}

  contains(other: FakeElement | null): boolean {
    for (let n = other; n; n = n.parentElement) if (n === this) return true;
    return false;
  }

  append(...kids: FakeElement[]) {
    for (const kid of kids) {
      kid.parentElement = this;
      this.children.push(kid);
    }
    return this;
  }

  descendants(): FakeElement[] {
    return this.children.flatMap((kid) => [kid, ...kid.descendants()]);
  }

  querySelectorAll(selector: string): FakeElement[] {
    const all = this.descendants();
    return selector === '*' ? all : all.filter((el) => el.tagName.toLowerCase() === selector);
  }

  closest(selector: string): FakeElement | null {
    for (let n: FakeElement | null = this; n; n = n.parentElement) {
      if (n.tagName.toLowerCase() === selector) return n;
    }
    return null;
  }
}

/** What the browser would report: the pass's inline writes win, colour inherits. */
function computed(el: FakeElement) {
  const own = (prop: string, css: string | undefined) => el.style.getPropertyValue(prop) || css;
  const color = (): string => {
    for (let n: FakeElement | null = el; n; n = n.parentElement) {
      const v = n.style.getPropertyValue('color') || n.css.color;
      if (v) return v;
    }
    return 'rgb(0, 0, 0)';
  };
  const border = el.css.border;
  return {
    color: color(),
    backgroundColor: own('background-color', el.css.backgroundColor) ?? 'rgba(0, 0, 0, 0)',
    backgroundImage: own('background-image', el.css.backgroundImage) ?? 'none',
    getPropertyValue(name: string) {
      const side = /^border-(top|right|bottom|left)-(style|width|color)$/.exec(name);
      if (!side) return '';
      if (side[2] === 'color') return el.style.getPropertyValue(name) || border || '';
      if (side[2] === 'style') return border ? 'solid' : 'none';
      return border ? '1px' : '0px';
    },
  };
}

function hex(value: string): string {
  const h = value.replace('#', '');
  const full = h.length === 3 ? h.split('').map((d) => d + d).join('') : h;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

const PHOTO = (() => {
  const data = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([(i * 37) % 255, (i * 11) % 255, (i * 5) % 255, 255], i);
  return data;
})();
const flat = (rgb: number[]) => {
  const data = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...rgb, 255], i);
  return data;
};

function makeDoc(content: FakeElement[], opts: { htmlBg?: string; bodyBg?: string; pixels?: Uint8ClampedArray; tainted?: boolean } = {}) {
  const html = new FakeElement('HTML', { backgroundColor: opts.htmlBg ?? 'rgb(255, 255, 255)' });
  const body = new FakeElement('BODY', { backgroundColor: opts.bodyBg ?? 'rgb(255, 255, 255)', color: 'rgb(26, 26, 26)' });
  html.classList.add(DARK_PENDING_CLASS);
  html.append(body);
  body.append(...content);
  const doc = {
    documentElement: html,
    body,
    defaultView: { getComputedStyle: computed },
    createElement: (tag: string) => tag === 'canvas'
      ? { getContext: () => ({ drawImage() {}, getImageData: () => {
        if (opts.tainted) throw new Error('SecurityError');
        return { data: opts.pixels ?? PHOTO };
      } }) }
      : { complete: true, naturalWidth: 4, naturalHeight: 4, src: '' },
    byId: (id: string) => html.descendants().find((e) => e.id === id)!,
  };
  return doc;
}

const SURFACE = c('rgb(46, 52, 64)');
const run = (doc: ReturnType<typeof makeDoc>, canvas: Rgba = SURFACE) => DM.apply(doc as unknown as Document, { canvas });
const writtenBg = (el: FakeElement) => {
  expect(el.style.getPropertyPriority('background-color')).toBe('important');
  return c(el.style.getPropertyValue('background-color'));
};
const writtenColor = (el: FakeElement) => c(el.style.getPropertyValue('color'));
const el = (tag: string, css: Css = {}, id = '', ...kids: FakeElement[]) => new FakeElement(tag, css, id).append(...kids);

const landsOn = (el: FakeElement, canvas: Rgba = SURFACE) => {
  expect(el.style.getPropertyPriority('background-color')).toBe('important');
  const value = el.style.getPropertyValue('background-color');
  return value === 'transparent' || DM.formatColor(c(value)) === DM.formatColor(canvas);
};
const GREY_PAGE = hex('#f2f2f2');
const greyOn = (canvas: Rgba) => DM.formatColor(DM.darkenBackground(c(GREY_PAGE), canvas));

describe('the DOM pass', () => {
  it('lands a white mail on the surface around it', () => {
    const doc = makeDoc([el('TABLE', {}, '', el('TR', {}, '', el('TD', { backgroundColor: hex('#fff') }, 'a')))]);
    run(doc);
    expect(landsOn(doc.documentElement)).toBe(true);
    expect(landsOn(doc.body)).toBe(true);
    expect(landsOn(doc.byId('a'))).toBe(true);
  });

  it('makes body text near white on it, and dark text on a white cell readable', () => {
    const doc = makeDoc([el('DIV', { backgroundColor: hex('#fff') }, 'd', el('P', { color: hex('#222') }, 'p'))]);
    run(doc);
    expect(DM.contrastRatio(writtenColor(doc.byId('p')), SURFACE)).toBeGreaterThan(9);
    expect(DM.contrastRatio(writtenColor(doc.body), SURFACE)).toBeLessThan(13.5);
  });

  it('keeps a grey page and the white card on it apart', () => {
    const doc = makeDoc([el('DIV', { backgroundColor: GREY_PAGE }, 'page', el('DIV', { backgroundColor: hex('#fff') }, 'card'))]);
    run(doc);
    const page = writtenBg(doc.byId('page'));
    expect(DM.formatColor(page)).toBe(greyOn(SURFACE));
    expect(DM.contrastRatio(page, SURFACE)).toBeGreaterThan(1.1);
    expect(DM.formatColor(writtenBg(doc.byId('card')))).toBe(DM.formatColor(SURFACE));
  });

  it('dims a bright brand button and keeps its label readable', () => {
    const doc = makeDoc([el('A', { backgroundColor: hex('#f38020'), color: hex('#ffffff') }, 'btn')]);
    run(doc);
    const btn = doc.byId('btn');
    const bg = writtenBg(btn);
    expect(lightness(bg)).toBeLessThan(lightness(c(hex('#f38020'))) * 0.7);
    const label = btn.style.getPropertyValue('color') ? writtenColor(btn) : WHITE;
    expect(DM.contrastRatio(label, bg)).toBeGreaterThan(4.5);
  });

  it('keeps a deep brand cell as sent', () => {
    const doc = makeDoc([el('TD', { backgroundColor: hex('#e30613'), color: hex('#ffffff') }, 'x')]);
    run(doc);
    expect(doc.byId('x').style.getPropertyValue('background-color')).toBe('');
  });

  it('leaves text on a background image as sent', () => {
    const doc = makeDoc([
      el('DIV', { backgroundImage: 'url("data:image/png;base64,AAAA")', backgroundColor: hex('#ffffff') }, 'photo',
        el('P', { color: hex('#111') }, 'p')),
    ]);
    run(doc);
    expect(doc.byId('p').style.getPropertyPriority('color')).toBe('');
    expect(doc.byId('photo').style.getPropertyPriority('background-color')).toBe('');
  });

  it('turns a tiled white picture into the surface, with readable text on it', async () => {
    const doc = makeDoc([
      el('DIV', { backgroundImage: 'url("data:image/png;base64,AAAA")' }, 'tile', el('P', { color: hex('#111') }, 'p')),
    ], { pixels: flat([255, 255, 255]) });
    await run(doc);
    const tile = doc.byId('tile');
    expect(tile.style.getPropertyValue('background-image')).toBe('none');
    expect(landsOn(tile)).toBe(true);
    expect(apca(writtenColor(doc.byId('p')), SURFACE)).toBeGreaterThanOrEqual(80);
    expect(doc.documentElement.classList.contains(DARK_PENDING_CLASS)).toBe(false);
  });

  it('puts the light box back behind a remote logo the WebView cannot read', async () => {
    const logo = Object.assign(new FakeElement('IMG', {}, 'logo'), {
      complete: true, naturalWidth: 240, naturalHeight: 64, src: 'https://news.example.com/logo.png', currentSrc: '',
    });
    const doc = makeDoc([el('TD', { backgroundColor: hex('#fff') }, 'cell', logo)], { tainted: true });
    Object.assign(logo, { ownerDocument: doc });
    await run(doc);
    expect(landsOn(doc.byId('cell'))).toBe(true);
    expect(DM.formatColor(writtenBg(logo))).toBe(DM.formatColor(WHITE));
    expect(logo.style.getPropertyValue('filter')).toBe('');
  });

  it('converts a cell whose remote background the blocker stripped', () => {
    const doc = makeDoc([
      el('TD', { backgroundImage: 'url("")', backgroundColor: hex('#ffffff') }, 'hero', el('P', { color: hex('#111') }, 'p')),
    ]);
    run(doc);
    expect(landsOn(doc.byId('hero'))).toBe(true);
    expect(doc.byId('p').style.getPropertyPriority('color')).toBe('important');
  });

  it('darkens a light border with the backgrounds', () => {
    const doc = makeDoc([el('DIV', { backgroundColor: hex('#ffffff'), border: hex('#dddddd') }, 'card')]);
    run(doc);
    const card = doc.byId('card');
    expect(card.style.getPropertyPriority('border-top-color')).toBe('important');
    expect(lightness(c(card.style.getPropertyValue('border-top-color')))).toBeLessThan(110);
  });

  it('un-hides the body', () => {
    const doc = makeDoc([el('P')]);
    run(doc);
    expect(doc.documentElement.classList.contains(DARK_PENDING_CLASS)).toBe(false);
  });

  // In a page, <img name="body"> is what document.body returns, and so on for
  // documentElement and defaultView; Document.prototype still has the real ones.
  it('converts and un-hides the page when the mail names elements after the document\'s parts', () => {
    const real = makeDoc([el('TD', { backgroundColor: GREY_PAGE }, 'a')]);
    class FakeDocument {}
    for (const name of ['body', 'documentElement', 'defaultView'] as const) {
      Object.defineProperty(FakeDocument.prototype, name, { get: () => real[name] });
    }
    const page = Object.create(FakeDocument.prototype) as Record<string, unknown>;
    const named = new FakeElement('IMG');
    for (const name of ['body', 'documentElement', 'defaultView']) Object.defineProperty(page, name, { value: named });
    const globals = globalThis as { Document?: unknown };
    const before = globals.Document;
    globals.Document = FakeDocument;
    try {
      new Function('document', 'window', buildEmailDarkModeScript({ canvas: SURFACE }))(page, {});
    } finally {
      globals.Document = before;
    }
    expect(real.documentElement.classList.contains(DARK_PENDING_CLASS)).toBe(false);
    expect(DM.formatColor(writtenBg(real.byId('a')))).toBe(greyOn(SURFACE));
  });
});

describe('buildEmailDarkModeScript', () => {
  const inject = (script: string, doc: ReturnType<typeof makeDoc>) => {
    const win: Record<string, unknown> = {};
    new Function('document', 'window', script)(doc, win);
  };

  it('works on the canvas it is given', () => {
    const mocha = c('rgb(30, 30, 46)');
    const doc = makeDoc([el('TD', { backgroundColor: GREY_PAGE }, 'a')]);
    inject(buildEmailDarkModeScript({ remoteContentAllowed: false, canvas: mocha }), doc);
    expect(DM.formatColor(writtenBg(doc.byId('a')))).toBe(greyOn(mocha));
    expect(greyOn(mocha)).not.toBe(greyOn(SURFACE));
  });

  it('runs the pass on the page once, however often the view injects it', () => {
    const doc = makeDoc([el('TD', { backgroundColor: GREY_PAGE }, 'a')]);
    const script = buildEmailDarkModeScript({ remoteContentAllowed: false, canvas: SURFACE });
    inject(script, doc);
    expect(DM.formatColor(writtenBg(doc.byId('a')))).toBe(greyOn(SURFACE));
    // A second pass would read the darkened colour back and could shift it.
    doc.byId('a').style.setProperty('background-color', 'rgb(255, 255, 255)');
    inject(script, doc);
    expect(doc.byId('a').style.getPropertyValue('background-color')).toBe('rgb(255, 255, 255)');
  });

  it('keeps the body hidden while a background picture is read, then shows it converted', async () => {
    const doc = makeDoc([
      el('DIV', { backgroundImage: 'url("data:image/png;base64,AAAA")' }, 'tile', el('P', { color: hex('#111') }, 'p')),
    ], { pixels: flat([255, 255, 255]) });
    inject(buildEmailDarkModeScript({ remoteContentAllowed: false, canvas: SURFACE }), doc);
    expect(doc.documentElement.classList.contains(DARK_PENDING_CLASS)).toBe(true);
    await vi.waitFor(() => expect(doc.documentElement.classList.contains(DARK_PENDING_CLASS)).toBe(false));
    expect(landsOn(doc.byId('tile'))).toBe(true);
    expect(apca(writtenColor(doc.byId('p')), SURFACE)).toBeGreaterThanOrEqual(80);
  });

  it('shows the body even when the pass throws', () => {
    const doc = makeDoc([el('P')]);
    (doc.defaultView as { getComputedStyle: unknown }).getComputedStyle = () => { throw new Error('boom'); };
    inject(buildEmailDarkModeScript(), doc);
    expect(doc.documentElement.classList.contains(DARK_PENDING_CLASS)).toBe(false);
  });

  it('shows the body even when the engine fails before its pass starts', () => {
    const doc = makeDoc([el('P')]);
    Object.defineProperty(doc, 'defaultView', { get() { throw new Error('boom'); } });
    inject(buildEmailDarkModeScript(), doc);
    expect(doc.documentElement.classList.contains(DARK_PENDING_CLASS)).toBe(false);
  });
});

describe('the mail canvas in every dark theme', () => {
  const themes: Array<[string, string]> = [
    ['standard', DARK_COLORS.background],
    ...BUILTIN_THEMES.map((t): [string, string] => [t.name, { ...DARK_COLORS, ...t.dark }.background]),
  ];

  it.each(themes)('%s: a white mail lands exactly on the theme background, and its greys a step above it', (_name, background) => {
    const canvas = emailDarkCanvas(background);
    expect(DM.formatColor(canvas)).toBe(hex(background));
    expect(DM.formatColor(DM.darkenBackground(WHITE, canvas))).toBe(hex(background));
    expect(emailDarkModeCss(canvas)).toContain(`background-color: ${hex(background)} !important`);
    const doc = makeDoc([el('TD', { backgroundColor: GREY_PAGE }, 'page', el('DIV', { backgroundColor: hex('#fff') }, 'card'))]);
    new Function('document', 'window', buildEmailDarkModeScript({ canvas }))(doc, {});
    expect(landsOn(doc.documentElement, canvas)).toBe(true);
    expect(DM.formatColor(writtenBg(doc.byId('page')))).toBe(greyOn(canvas));
    expect(DM.formatColor(writtenBg(doc.byId('card')))).toBe(hex(background));
  });

  it.each(themes)('%s: body text reads the same, and greys and links stay readable', (_name, background) => {
    const canvas = emailDarkCanvas(background);
    const doc = makeDoc([
      el('P', { color: hex('#222') }, 'body'),
      el('P', { color: hex('#999') }, 'fine'),
      el('A', { color: hex('#0969da') }, 'link'),
    ]);
    new Function('document', 'window', buildEmailDarkModeScript({ canvas }))(doc, {});
    const body = c(DM.formatColor(writtenColor(doc.byId('body'))));
    expect(apca(body, canvas)).toBeGreaterThanOrEqual(80);
    expect(apca(body, canvas)).toBeLessThanOrEqual(90);
    for (const id of ['fine', 'link']) {
      const text = writtenColor(doc.byId(id));
      expect(apca(text, canvas)).toBeGreaterThanOrEqual(60);
      expect(DM.contrastRatio(text, canvas)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("is fed from the active theme's dark palette by the body view, which paints it behind the mail", () => {
    const view = fs.readFileSync(path.resolve(__dirname, '../../components/EmailBodyView.tsx'), 'utf8');
    expect(view).toMatch(/const darkCanvas = resolvePalette\('dark', activeThemeId\)\.background;/);
    expect(view).toMatch(/isDark: renderAsDark,\r?\n\s*darkCanvas,\r?\n/);
    expect(view).toMatch(/shouldBlock, cidMap, renderAsDark, darkCanvas,\r?\n\s*messageSpacing,/);
    expect(view).toMatch(/\[prepared\.isHtml, prepared\.recolorDark, shouldBlock, darkCanvas, quoteLabels,/);
    expect(view).toMatch(/buildEmailDarkModeScript\(\{ remoteContentAllowed: !shouldBlock, canvas: emailDarkCanvas\(darkCanvas\) \}\)/);
    expect(view).toMatch(/const darkSurface = prepared\.recolorDark \? \{ backgroundColor: emailDarkCanvasColor\(darkCanvas\) \} : undefined;/);
    expect(view).toMatch(/<View style=\{\[styles\.webContainer, containerSize, darkSurface\]\}>/);
  });
});
