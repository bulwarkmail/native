/**
 * App only (the webmail uses the browser's DOMParser): the HTML parser
 * extract.ts reads booking markup with. React Native has no DOM, so this
 * builds a small detached tree that answers the few DOM calls extract.ts
 * makes (querySelectorAll, closest, getAttribute, hasAttribute, textContent,
 * parentElement, tagName, getElementById, compareDocumentPosition) and
 * nothing else. It runs no script and loads nothing: it only reads text.
 *
 * The tokenizer is the one src/lib/email-html.ts sanitises mail with
 * (readTag and the loop in rewriteTags, at 440a2e7a), copied because
 * email-html.ts keeps it private. Tree building follows the browser where it
 * matters for markup in mail: void elements, raw-text elements (a JSON-LD
 * script is read verbatim up to its end tag), the end tags HTML implies
 * (a <p> closed by a block, an <li> by the next <li>, table cells and rows),
 * stray end tags ignored, character references decoded in text and
 * attribute values. Misnested formatting tags are not re-parented the way the
 * browser's adoption agency does; that changes nothing extract.ts asks.
 */

// ---------------------------------------------------------------------------
// tokenizer (src/lib/email-html.ts)

interface ParsedAttr {
  name: string;
  /** Raw value (character references intact), or null for a boolean attribute. */
  value: string | null;
}

interface ParsedTag {
  name: string;
  attrs: ParsedAttr[];
  selfClosing: boolean;
  /** Index just past the closing `>`. */
  end: number;
}

function isHtmlSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r';
}

function isAsciiAlpha(ch: string | undefined): boolean {
  if (!ch) return false;
  const code = ch.charCodeAt(0) | 0x20;
  return code >= 97 && code <= 122;
}

/** The browser lowercases tag and attribute names in ASCII only. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/**
 * Read a start or end tag whose name begins at `i`. Returns null when the
 * input ends inside the tag: the browser drops such a tag and everything
 * after it.
 */
function readTag(html: string, i: number): ParsedTag | null {
  const n = html.length;
  let j = i;
  while (j < n && !isHtmlSpace(html[j]) && html[j] !== '/' && html[j] !== '>') j++;
  const name = html.slice(i, j);
  const attrs: ParsedAttr[] = [];
  while (j < n) {
    const ch = html[j];
    if (isHtmlSpace(ch)) { j++; continue; }
    if (ch === '>') return { name, attrs, selfClosing: false, end: j + 1 };
    if (ch === '/') {
      j++;
      if (html[j] === '>') return { name, attrs, selfClosing: true, end: j + 1 };
      continue;
    }
    const start = j;
    j++;
    while (j < n && !isHtmlSpace(html[j]) && html[j] !== '/' && html[j] !== '>' && html[j] !== '=') j++;
    const attrName = html.slice(start, j);
    while (j < n && isHtmlSpace(html[j])) j++;
    if (html[j] !== '=') {
      attrs.push({ name: attrName, value: null });
      continue;
    }
    j++;
    while (j < n && isHtmlSpace(html[j])) j++;
    if (j >= n) return null;
    const q = html[j];
    if (q === '"' || q === "'") {
      const close = html.indexOf(q, j + 1);
      if (close < 0) return null;
      attrs.push({ name: attrName, value: html.slice(j + 1, close) });
      j = close + 1;
    } else if (q === '>') {
      attrs.push({ name: attrName, value: '' });
    } else {
      const s = j;
      while (j < n && !isHtmlSpace(html[j]) && html[j] !== '>') j++;
      attrs.push({ name: attrName, value: html.slice(s, j) });
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// character references

const LATIN1_NAMES = (
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 '
  + 'acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml '
  + 'Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde '
  + 'Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig '
  + 'ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide '
  + 'oslash ugrave uacute ucirc uuml yacute thorn yuml'
).split(' ');

/** Named references the browser also reads without a `;` (the legacy set). */
const LEGACY_ENTITIES: Record<string, number> = { amp: 38, lt: 60, gt: 62, quot: 34, AMP: 38, LT: 60, GT: 62, QUOT: 34 };
LATIN1_NAMES.forEach((name, i) => { LEGACY_ENTITIES[name] = 160 + i; });

/** Named references that need their `;`: the ones mail commonly carries beyond Latin-1. */
const NAMED_ENTITIES: Record<string, number> = {
  ...LEGACY_ENTITIES,
  apos: 39, euro: 0x20ac, ndash: 0x2013, mdash: 0x2014, lsquo: 0x2018, rsquo: 0x2019, sbquo: 0x201a,
  ldquo: 0x201c, rdquo: 0x201d, bdquo: 0x201e, dagger: 0x2020, Dagger: 0x2021, bull: 0x2022, hellip: 0x2026,
  permil: 0x2030, prime: 0x2032, Prime: 0x2033, lsaquo: 0x2039, rsaquo: 0x203a, trade: 0x2122,
  larr: 0x2190, uarr: 0x2191, rarr: 0x2192, darr: 0x2193, harr: 0x2194, rArr: 0x21d2, lArr: 0x21d0,
  minus: 0x2212, ensp: 0x2002, emsp: 0x2003, thinsp: 0x2009, zwnj: 0x200c, zwj: 0x200d, lrm: 0x200e,
  rlm: 0x200f, OElig: 0x152, oelig: 0x153, Scaron: 0x160, scaron: 0x161, Yuml: 0x178, fnof: 0x192,
  circ: 0x2c6, tilde: 0x2dc, Alpha: 0x391, alpha: 0x3b1, Beta: 0x392, beta: 0x3b2, mu: 0x3bc, pi: 0x3c0,
  Omega: 0x3a9, omega: 0x3c9, infin: 0x221e, ne: 0x2260, le: 0x2264, ge: 0x2265, asymp: 0x2248,
  check: 0x2713, star: 0x2606, starf: 0x2605, hearts: 0x2665, loz: 0x25ca, NewLine: 10, Tab: 9,
  colon: 58, comma: 44, period: 46, sol: 47, bsol: 92, num: 35, dollar: 36, percnt: 37, lpar: 40,
  rpar: 41, ast: 42, plus: 43, equals: 61, quest: 63, commat: 64, lsqb: 91, rsqb: 93, lowbar: 95,
  grave: 96, lcub: 123, rcub: 125, verbar: 124, excl: 33,
};

/** C1 numeric references the browser reads as windows-1252. */
const WINDOWS_1252: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x2c6, 0x89: 0x2030, 0x8a: 0x160, 0x8b: 0x2039, 0x8c: 0x152, 0x8e: 0x17d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x2dc,
  0x99: 0x2122, 0x9a: 0x161, 0x9b: 0x203a, 0x9c: 0x153, 0x9e: 0x17e, 0x9f: 0x178,
};

function codePointText(code: number): string {
  if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return String.fromCharCode(0xfffd);
  return String.fromCodePoint(WINDOWS_1252[code] ?? code);
}

const REFERENCE = /&(?:#[xX]([0-9a-fA-F]+);?|#([0-9]+);?|([A-Za-z][A-Za-z0-9]*);?)/g;

/** Decode character references the way the browser does in text (or, with `attribute`, in a value). */
export function decodeCharacterReferences(text: string, attribute = false): string {
  if (!text.includes('&')) return text;
  return text.replace(REFERENCE, (match: string, hex: string | undefined, dec: string | undefined, name: string | undefined, offset: number) => {
    if (hex !== undefined) return codePointText(parseInt(hex, 16));
    if (dec !== undefined) return codePointText(parseInt(dec, 10));
    const withSemicolon = match.endsWith(';');
    if (withSemicolon && name && NAMED_ENTITIES[name] !== undefined) return String.fromCodePoint(NAMED_ENTITIES[name]);
    // Without `;` only a legacy name counts, read as the longest one that
    // prefixes the run ("&copy2026" is "©2026"); in a value not when an
    // alphanumeric or `=` follows it ("?a=1&copy=2" stays a query string).
    for (let len = Math.min(name?.length ?? 0, 6); len >= 2; len--) {
      const candidate = name!.slice(0, len);
      const code = LEGACY_ENTITIES[candidate];
      if (code === undefined) continue;
      const rest = match.slice(1 + len);
      if (attribute) {
        const next = rest[0] ?? text[offset + match.length];
        if (next !== undefined && /[A-Za-z0-9=]/.test(next)) return match;
      }
      return String.fromCodePoint(code) + rest;
    }
    return match;
  });
}

// ---------------------------------------------------------------------------
// tree

const VOID_ELEMENTS = new Set([
  'area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr', 'img', 'input', 'keygen',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** Read as text up to their end tag. A DOMParser document runs no script, so <noscript> is markup. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);
/** Read as text with character references decoded. */
const RCDATA_ELEMENTS = new Set(['title', 'textarea']);

/** Start tags that close an open <p> (HTML "in body" insertion mode). */
const CLOSES_P = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr',
  'listing', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'search', 'section', 'summary', 'table', 'ul', 'li',
  'dd', 'dt', 'plaintext', 'xmp',
]);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
/** Elements an implied end tag never reaches past. */
const SCOPE_BOUNDARIES = new Set(['html', 'table', 'td', 'th', 'caption', 'template', 'object', 'applet', 'marquee', 'button']);

let nextOrder = 0;

class MiniText {
  readonly nodeType = 3;
  constructor(public data: string) {}
}

type MiniChild = MiniElement | MiniText;

abstract class MiniParent {
  children: MiniChild[] = [];

  get textContent(): string {
    let out = '';
    const walk = (node: MiniParent) => {
      for (const child of node.children) {
        if (child instanceof MiniText) out += child.data;
        else walk(child);
      }
    };
    walk(this);
    return out;
  }

  /** Elements below this node in document order, not entering <template> content. */
  protected descendants(): MiniElement[] {
    const out: MiniElement[] = [];
    const walk = (node: MiniParent) => {
      for (const child of node.children) {
        if (!(child instanceof MiniElement)) continue;
        out.push(child);
        if (child.localName !== 'template') walk(child);
      }
    };
    walk(this);
    return out;
  }

  querySelectorAll(selector: string): MiniElement[] {
    const match = compileSelector(selector);
    return this.descendants().filter((element) => match(element));
  }

  querySelector(selector: string): MiniElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class MiniElement extends MiniParent {
  readonly nodeType = 1;
  readonly order = nextOrder++;
  /** Order of the last element inside this one; set when the element closes. */
  lastInside = this.order;
  parent: MiniParent | null = null;
  private readonly attributes: Map<string, string>;

  constructor(readonly localName: string, attrs: ParsedAttr[], readonly quirks: boolean) {
    super();
    this.attributes = new Map();
    for (const attr of attrs) {
      const key = asciiLower(attr.name);
      // The browser keeps the first of each name.
      if (!this.attributes.has(key)) this.attributes.set(key, attr.value === null ? '' : decodeCharacterReferences(attr.value, true));
    }
  }

  get tagName(): string {
    return this.localName.toUpperCase();
  }

  get parentElement(): MiniElement | null {
    return this.parent instanceof MiniElement ? this.parent : null;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(asciiLower(name)) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(asciiLower(name));
  }

  closest(selector: string): MiniElement | null {
    const match = compileSelector(selector);
    for (let node: MiniElement | null = this; node; node = node.parentElement) {
      if (match(node)) return node;
    }
    return null;
  }

  /** DOCUMENT_POSITION_* bits of `other` relative to this element (elements only). */
  compareDocumentPosition(other: MiniElement): number {
    if (other === this) return 0;
    if (other.order > this.order) return other.order <= this.lastInside ? 4 | 16 : 4;
    return this.order <= other.lastInside ? 2 | 8 : 2;
  }
}

class MiniDocument extends MiniParent {
  readonly nodeType = 9;

  getElementById(id: string): MiniElement | null {
    if (!id) return null;
    return this.descendants().find((element) => element.getAttribute('id') === id) ?? null;
  }
}

// ---------------------------------------------------------------------------
// selectors: comma lists of compounds made of a tag, #id, .class and [attr] or [attr=value]

type Matcher = (element: MiniElement) => boolean;

const selectorCache = new Map<string, Matcher>();
const COMPOUND_PART = /^(?:#([-\w]+)|\.([-\w]+)|\[\s*([-\w:]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*))\s*)?\])/;

function compileCompound(source: string): Matcher {
  let rest = source;
  const tag = /^([A-Za-z][-\w]*|\*)/.exec(rest);
  const tests: Matcher[] = [];
  if (tag) {
    const name = asciiLower(tag[1]);
    if (name !== '*') tests.push((element) => element.localName === name);
    rest = rest.slice(tag[0].length);
  }
  while (rest.length > 0) {
    const part = COMPOUND_PART.exec(rest);
    if (!part) throw new Error(`html-parser: unsupported selector "${source}"`);
    const [, id, cls, attr] = part;
    const value = part[4] ?? part[5] ?? part[6];
    if (id !== undefined) {
      tests.push((element) => {
        const own = element.getAttribute('id');
        // Quirks mode (no doctype) matches ids and classes ASCII case-insensitively.
        return own !== null && (element.quirks ? asciiLower(own) === asciiLower(id) : own === id);
      });
    } else if (cls !== undefined) {
      tests.push((element) => {
        const classes = (element.getAttribute('class') ?? '').split(/[\t\n\f\r ]+/);
        return element.quirks ? classes.some((c) => asciiLower(c) === asciiLower(cls)) : classes.includes(cls);
      });
    } else if (attr !== undefined) {
      tests.push(value === undefined
        ? (element) => element.hasAttribute(attr)
        : (element) => element.getAttribute(attr) === value);
    }
    rest = rest.slice(part[0].length);
  }
  if (tests.length === 0) return () => true;
  return (element) => tests.every((test) => test(element));
}

function compileSelector(selector: string): Matcher {
  const cached = selectorCache.get(selector);
  if (cached) return cached;
  const groups = selector.split(',').map((group) => group.trim());
  if (groups.some((group) => group === '' || /[\s>+~]/.test(group))) {
    throw new Error(`html-parser: unsupported selector "${selector}"`);
  }
  const compiled = groups.map(compileCompound);
  const matcher: Matcher = (element) => compiled.some((match) => match(element));
  selectorCache.set(selector, matcher);
  return matcher;
}

// ---------------------------------------------------------------------------
// tree building

class TreeBuilder {
  readonly doc = new MiniDocument();
  private readonly stack: MiniParent[] = [this.doc];

  constructor(private readonly quirks: boolean) {}

  private get current(): MiniParent {
    return this.stack[this.stack.length - 1];
  }

  text(data: string): void {
    if (!data) return;
    const children = this.current.children;
    const last = children[children.length - 1];
    if (last instanceof MiniText) last.data += data;
    else children.push(new MiniText(data));
  }

  /** Index in the stack of the nearest open element named one of `names`, not past a scope boundary. */
  private findOpen(names: Set<string> | string, boundaries: Set<string> = SCOPE_BOUNDARIES): number {
    const wanted = typeof names === 'string' ? new Set([names]) : names;
    for (let i = this.stack.length - 1; i > 0; i--) {
      const element = this.stack[i] as MiniElement;
      if (wanted.has(element.localName)) return i;
      if (boundaries.has(element.localName)) return -1;
    }
    return -1;
  }

  private popTo(index: number): void {
    while (this.stack.length > index) {
      const element = this.stack.pop() as MiniElement;
      element.lastInside = nextOrder - 1;
    }
  }

  private closeIfOpen(names: Set<string> | string, boundaries?: Set<string>): void {
    const index = this.findOpen(names, boundaries);
    if (index > 0) this.popTo(index);
  }

  start(name: string, attrs: ParsedAttr[]): MiniElement {
    if (CLOSES_P.has(name)) this.closeIfOpen('p', new Set([...SCOPE_BOUNDARIES]));
    if (HEADINGS.has(name) && this.current instanceof MiniElement && HEADINGS.has(this.current.localName)) {
      this.popTo(this.stack.length - 1);
    }
    switch (name) {
      case 'li': this.closeIfOpen('li', new Set([...SCOPE_BOUNDARIES, 'ul', 'ol'])); break;
      case 'dd': case 'dt': this.closeIfOpen(new Set(['dd', 'dt']), new Set([...SCOPE_BOUNDARIES, 'dl'])); break;
      case 'td': case 'th': this.closeIfOpen(new Set(['td', 'th']), new Set(['table', 'tr', 'html', 'template'])); break;
      case 'tr': this.closeIfOpen('tr', new Set(['table', 'html', 'template'])); break;
      case 'thead': case 'tbody': case 'tfoot':
        this.closeIfOpen(new Set(['thead', 'tbody', 'tfoot']), new Set(['table', 'html', 'template'])); break;
      case 'option': this.closeIfOpen('option', new Set(['select', 'html', 'template'])); break;
      case 'a': this.closeIfOpen('a'); break;
      default: break;
    }
    const element = new MiniElement(name, attrs, this.quirks);
    element.parent = this.current;
    this.current.children.push(element);
    if (!VOID_ELEMENTS.has(name)) this.stack.push(element);
    return element;
  }

  end(name: string): void {
    if (name === 'br') {
      this.start('br', []);
      return;
    }
    if (name === 'p' && this.findOpen('p') < 0) {
      // A stray </p> makes an empty paragraph.
      this.start('p', []);
    }
    for (let i = this.stack.length - 1; i > 0; i--) {
      if ((this.stack[i] as MiniElement).localName === name) {
        this.popTo(i);
        return;
      }
    }
    // An end tag with nothing open by that name is ignored.
  }

  finish(): MiniDocument {
    this.popTo(1);
    return this.doc;
  }
}

/** Parse `html` into a detached tree that answers the DOM calls extract.ts makes. */
export function parseHtmlDocument(html: string): Document {
  const n = html.length;
  const quirks = !/^\s*(?:<!--[\s\S]*?-->\s*)*<!doctype/i.test(html.slice(0, 4096));
  const builder = new TreeBuilder(quirks);
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      builder.text(decodeCharacterReferences(html.slice(i)));
      break;
    }
    builder.text(decodeCharacterReferences(html.slice(i, lt)));
    const next = html[lt + 1];

    if (isAsciiAlpha(next)) {
      const tag = readTag(html, lt + 1);
      if (!tag) break;
      const lower = asciiLower(tag.name);
      builder.start(lower, tag.attrs);
      i = tag.end;
      if (RAW_TEXT_ELEMENTS.has(lower) || RCDATA_ELEMENTS.has(lower)) {
        const close = new RegExp(`</${lower}[\\t\\n\\f\\r />]`, 'gi');
        close.lastIndex = i;
        const m = lower === 'plaintext' ? null : close.exec(html);
        const textEnd = m ? m.index : n;
        const text = html.slice(i, textEnd);
        builder.text(RCDATA_ELEMENTS.has(lower) ? decodeCharacterReferences(text) : text);
        i = textEnd;
      }
      continue;
    }

    if (next === '/') {
      const after = html[lt + 2];
      if (isAsciiAlpha(after)) {
        const tag = readTag(html, lt + 2);
        if (!tag) break;
        builder.end(asciiLower(tag.name));
        i = tag.end;
        continue;
      }
      if (after === '>') {
        i = lt + 3;
        continue;
      }
      if (after === undefined) {
        builder.text('</');
        break;
      }
      const gt = html.indexOf('>', lt + 2);
      i = gt < 0 ? n : gt + 1;
      continue;
    }

    if (next === '!') {
      if (html.startsWith('<!--', lt)) {
        const k = lt + 4;
        if (html[k] === '>') { i = k + 1; continue; }
        if (html.startsWith('->', k)) { i = k + 2; continue; }
        const a = html.indexOf('-->', k);
        const b = html.indexOf('--!>', k);
        if (a < 0 && b < 0) { i = n; continue; }
        i = a >= 0 && (b < 0 || a < b) ? a + 3 : b + 4;
        continue;
      }
      const gt = html.indexOf('>', lt + 2);
      i = gt < 0 ? n : gt + 1;
      continue;
    }

    if (next === '?') {
      const gt = html.indexOf('>', lt + 2);
      i = gt < 0 ? n : gt + 1;
      continue;
    }

    builder.text('<');
    i = lt + 1;
  }
  // Only what extract.ts calls is there; the cast says so to the type checker.
  return builder.finish() as unknown as Document;
}
