// The dark-mode recolour pass (webmail lib/email-dark-mode.ts). The pass is
// JavaScript source injected into the mail WebView; these tests evaluate that
// same source. The colour cases are the webmail's
// (lib/__tests__/email-dark-mode.test.ts). The app has no DOM library, so the
// DOM pass runs on a small fake document that answers getComputedStyle the
// way a browser does for the parts the pass reads (inline styles win, colour
// inherits, everything else has its initial value).
import { describe, it, expect } from 'vitest';
import {
  DARK_PENDING_CLASS,
  EMAIL_DARK_MODE_LIB,
  buildEmailDarkModeScript,
  emailColorScheme,
  resolveColorSchemeMedia,
  type EmailDarkModeLib,
  type Rgba,
} from '../email-dark-mode';

const DM = new Function(`return ${EMAIL_DARK_MODE_LIB}`)()() as EmailDarkModeLib;
const c = (value: string): Rgba => DM.parseComputedColor(value)!;
const lightness = ({ r, g, b }: Rgba) => (r + g + b) / 3;

describe('darkenBackground', () => {
  it('turns white into a dark canvas', () => {
    expect(lightness(DM.darkenBackground(c('rgb(255, 255, 255)')))).toBeLessThan(40);
  });

  it('keeps a light grey canvas lighter than a white card on it', () => {
    const card = DM.darkenBackground(c('rgb(255, 255, 255)'));
    const canvas = DM.darkenBackground(c('rgb(244, 244, 244)'));
    expect(lightness(canvas)).toBeGreaterThan(lightness(card));
  });

  it('keeps the hue of a light tint', () => {
    const out = DM.darkenBackground(c('rgb(214, 233, 248)'));
    expect(lightness(out)).toBeLessThan(80);
    expect(out.b).toBeGreaterThan(out.r);
  });

  it('leaves vivid brand colours and dark fills as sent', () => {
    const red = c('rgb(227, 6, 19)');
    const green = c('rgb(115, 215, 0)');
    const navy = c('rgb(0, 32, 91)');
    expect(DM.darkenBackground(red)).toBe(red);
    expect(DM.darkenBackground(green)).toBe(green);
    expect(DM.darkenBackground(navy)).toBe(navy);
  });

  it('keeps alpha', () => {
    expect(DM.darkenBackground(c('rgba(255, 255, 255, 0.5)')).a).toBe(0.5);
  });
});

describe('ensureContrast', () => {
  const dark = c('rgb(20, 20, 20)');

  it('keeps text that already reads', () => {
    const white = c('rgb(255, 255, 255)');
    expect(DM.ensureContrast(white, dark, 4.5)).toBe(white);
  });

  it('lifts dark text above 4.5:1 on a dark background', () => {
    const out = DM.ensureContrast(c('rgb(51, 51, 51)'), dark, 4.5);
    expect(DM.contrastRatio(out, dark)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the order of text greys', () => {
    const black = DM.ensureContrast(c('rgb(0, 0, 0)'), dark, 4.5);
    const grey = DM.ensureContrast(c('rgb(102, 102, 102)'), dark, 4.5);
    expect(lightness(black)).toBeGreaterThan(lightness(grey));
  });

  it('keeps a red link red', () => {
    const out = DM.ensureContrast(c('rgb(200, 0, 0)'), dark, 4.5);
    expect(out.r).toBeGreaterThan(out.g + 60);
  });
});

describe('parseComputedColor / formatColor', () => {
  it('reads the forms getComputedStyle returns', () => {
    expect(c('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(c('rgba(1, 2, 3, 0.5)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    expect(c('rgb(1 2 3 / 50%)')).toEqual({ r: 1, g: 2, b: 3, a: 0.5 });
    expect(DM.parseComputedColor('transparent')).toBeNull();
  });

  it('writes rgb() when opaque and rgba() otherwise', () => {
    expect(DM.formatColor({ r: 1.4, g: 2, b: 3, a: 1 })).toBe('rgb(1, 2, 3)');
    expect(DM.formatColor({ r: 1, g: 2, b: 3, a: 0.25 })).toBe('rgba(1, 2, 3, 0.25)');
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
  constructor(public tagName: string, public css: Css = {}, public id = '') {}

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

/**
 * A document in the state the head CSS leaves it in: pending class on
 * <html>, our dark canvas on <html> and <body>, light fallback text.
 */
function makeDoc(content: FakeElement[], opts: { htmlBg?: string; bodyBg?: string } = {}) {
  const html = new FakeElement('HTML', { backgroundColor: opts.htmlBg ?? 'rgb(20, 20, 20)' });
  const body = new FakeElement('BODY', { backgroundColor: opts.bodyBg ?? 'rgb(20, 20, 20)', color: 'rgb(230, 230, 230)' });
  html.classList.add(DARK_PENDING_CLASS);
  html.append(body);
  body.append(...content);
  const doc = {
    documentElement: html,
    body,
    defaultView: { getComputedStyle: computed },
    byId: (id: string) => html.descendants().find((e) => e.id === id)!,
  };
  return doc;
}

const run = (doc: ReturnType<typeof makeDoc>) => DM.apply(doc as unknown as Document);
const writtenBg = (el: FakeElement) => {
  expect(el.style.getPropertyPriority('background-color')).toBe('important');
  return c(el.style.getPropertyValue('background-color'));
};
const el = (tag: string, css: Css = {}, id = '', ...kids: FakeElement[]) => new FakeElement(tag, css, id).append(...kids);

describe('the DOM pass', () => {
  it('darkens a white cell', () => {
    const doc = makeDoc([el('TABLE', {}, '', el('TR', {}, '', el('TD', { backgroundColor: hex('#fff') }, 'a')))]);
    run(doc);
    expect(lightness(writtenBg(doc.byId('a')))).toBeLessThan(40);
  });

  it('makes dark text on a darkened cell readable', () => {
    const doc = makeDoc([el('DIV', { backgroundColor: hex('#fff') }, 'd', el('P', { color: hex('#222') }, 'p'))]);
    run(doc);
    const p = doc.byId('p');
    expect(p.style.getPropertyPriority('color')).toBe('important');
    const bg = writtenBg(doc.byId('d'));
    expect(DM.contrastRatio(c(p.style.getPropertyValue('color')), bg)).toBeGreaterThan(4.5);
  });

  it('keeps a brand button and its label as sent', () => {
    const doc = makeDoc([el('A', { backgroundColor: hex('#e30613'), color: hex('#ffffff') }, 'btn')]);
    run(doc);
    const btn = doc.byId('btn');
    expect(btn.style.getPropertyPriority('background-color')).toBe('');
    expect(btn.style.getPropertyPriority('color')).toBe('');
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

  it('converts a cell whose remote background the blocker stripped', () => {
    const doc = makeDoc([
      el('TD', { backgroundImage: 'url("")', backgroundColor: hex('#ffffff') }, 'hero', el('P', { color: hex('#111') }, 'p')),
    ]);
    run(doc);
    expect(lightness(writtenBg(doc.byId('hero')))).toBeLessThan(40);
    expect(doc.byId('p').style.getPropertyPriority('color')).toBe('important');
  });

  it('keeps a vivid cell as sent', () => {
    const doc = makeDoc([el('TD', { backgroundColor: hex('#e30613'), color: hex('#ffffff') }, 'x')]);
    run(doc);
    expect(doc.byId('x').style.getPropertyValue('background-color')).toBe('');
  });

  it('darkens a light border with the backgrounds', () => {
    const doc = makeDoc([el('DIV', { backgroundColor: hex('#ffffff'), border: hex('#dddddd') }, 'card')]);
    run(doc);
    const card = doc.byId('card');
    expect(card.style.getPropertyPriority('border-top-color')).toBe('important');
    expect(lightness(c(card.style.getPropertyValue('border-top-color')))).toBeLessThan(110);
  });

  it('leaves the dark canvas behind a mail without colours alone', () => {
    const doc = makeDoc([el('P', {}, 'p')]);
    run(doc);
    expect(doc.body.style.getPropertyValue('background-color')).toBe('');
    expect(doc.documentElement.style.getPropertyValue('background-color')).toBe('');
    // Our light fallback text already reads on it.
    expect(doc.byId('p').style.getPropertyValue('color')).toBe('');
  });

  it('un-hides the body', () => {
    const doc = makeDoc([el('P')]);
    run(doc);
    expect(doc.documentElement.classList.contains(DARK_PENDING_CLASS)).toBe(false);
  });

  // Newsletters (Lieferando) paint the canvas through `html { background }`.
  it('darkens a canvas the mail paints on <html>', () => {
    const doc = makeDoc([el('P')], { htmlBg: hex('#ffffff'), bodyBg: hex('#ffffff') });
    run(doc);
    expect(lightness(writtenBg(doc.documentElement))).toBeLessThan(40);
    expect(lightness(writtenBg(doc.body))).toBeLessThan(40);
  });
});

describe('buildEmailDarkModeScript', () => {
  const inject = (script: string, doc: ReturnType<typeof makeDoc>) => {
    const win: Record<string, unknown> = {};
    new Function('document', 'window', script)(doc, win);
  };

  it('runs the pass on the page once, however often the view injects it', () => {
    const doc = makeDoc([el('TD', { backgroundColor: hex('#fff') }, 'a')]);
    const script = buildEmailDarkModeScript({ remoteContentAllowed: false });
    inject(script, doc);
    const first = doc.byId('a').style.getPropertyValue('background-color');
    expect(lightness(c(first))).toBeLessThan(40);
    // A second pass would read the darkened colour back and could shift it.
    doc.byId('a').style.setProperty('background-color', 'rgb(255, 255, 255)');
    inject(script, doc);
    expect(doc.byId('a').style.getPropertyValue('background-color')).toBe('rgb(255, 255, 255)');
  });

  it('shows the body even when the pass throws', () => {
    const doc = makeDoc([el('P')]);
    (doc.defaultView as { getComputedStyle: unknown }).getComputedStyle = () => { throw new Error('boom'); };
    inject(buildEmailDarkModeScript(), doc);
    expect(doc.documentElement.classList.contains(DARK_PENDING_CLASS)).toBe(false);
  });
});
