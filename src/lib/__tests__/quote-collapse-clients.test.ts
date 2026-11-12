import { describe, it, expect } from 'vitest';
import { buildQuoteCollapseScript, QUOTE_COLLAPSED_ATTR, QUOTE_TOGGLE_ATTR } from '../quote-collapse';

// Quoted history of iPhone Mail and Outlook replies wasn't folded (webmail
// #1476): Outlook for Windows marks its header block only by its top rule,
// Outlook mobile wraps the original in #mail-editor-reference-message-container,
// and iPhone Mail puts the attribution line and the original in two cite
// blockquotes in a row. The injected script runs here against a small fake
// DOM with just enough of a selector engine for the reader's selectors.

class FNode {
  parentNode: FEl | null = null;
  get parentElement(): FEl | null { return this.parentNode; }
}

class FText extends FNode {
  nodeType = 3;
  constructor(public nodeValue: string) { super(); }
}

/** Matches one compound selector: tag, #id, .class, [attr="v"], [attr*="v" i]. */
function matchesOne(el: FEl, sel: string): boolean {
  const attrs = [...sel.matchAll(/\[([\w-]+)(?:(\*?=)"([^"]*)"(\s+i)?)?\]/g)];
  const head = sel.replace(/\[[^\]]*\]/g, '');
  const tag = /^[a-z]+/i.exec(head)?.[0];
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  const id = /#([\w-]+)/.exec(head)?.[1];
  if (id && el.getAttribute('id') !== id) return false;
  for (const m of head.matchAll(/\.([\w-]+)/g)) {
    if (!(el.getAttribute('class') ?? '').split(/\s+/).includes(m[1])) return false;
  }
  for (const m of attrs) {
    const raw = el.getAttribute(m[1]);
    if (raw === null) return false;
    if (!m[2]) continue;
    const [value, wanted] = m[4] ? [raw.toLowerCase(), m[3].toLowerCase()] : [raw, m[3]];
    if (m[2] === '=' ? value !== wanted : !value.includes(wanted)) return false;
  }
  return true;
}

const matchesList = (el: FEl, list: string) => list.split(',').some((s) => matchesOne(el, s.trim()));

class FEl extends FNode {
  nodeType = 1;
  tagName: string;
  childNodes: FNode[] = [];
  attrs = new Map<string, string>();
  style = { display: '', cssText: '' };
  title = '';
  textContent = '';
  constructor(tag: string, attrs: Record<string, string> = {}) {
    super();
    this.tagName = tag.toUpperCase();
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
  }
  append(...kids: Array<FNode | string>): this {
    for (const kid of kids) {
      const node = typeof kid === 'string' ? new FText(kid) : kid;
      node.parentNode = this;
      this.childNodes.push(node);
    }
    return this;
  }
  insertBefore(node: FNode, ref: FNode): void {
    node.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(ref), 0, node);
  }
  get nextElementSibling(): FEl | null {
    const sibs = this.parentNode?.childNodes ?? [];
    for (let i = sibs.indexOf(this) + 1; i < sibs.length; i++) if (sibs[i] instanceof FEl) return sibs[i] as FEl;
    return null;
  }
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  hasAttribute(k: string) { return this.attrs.has(k); }
  removeAttribute(k: string) { this.attrs.delete(k); }
  addEventListener() { /* not clicked here */ }
  matches(list: string) { return matchesList(this, list); }
  querySelector(list: string): FEl | null {
    return preorder(this).slice(1).find((n): n is FEl => n instanceof FEl && matchesList(n, list)) ?? null;
  }
  closest(list: string): FEl | null {
    for (let e: FEl | null = this; e; e = e.parentNode) if (matchesList(e, list)) return e;
    return null;
  }
  compareDocumentPosition(other: FNode): number {
    for (let p = other.parentNode; p; p = p.parentNode) if (p === this) return 16 | 4;
    const order = preorder(rootOf(this));
    return order.indexOf(other) < order.indexOf(this) ? 2 : 4;
  }
}

function rootOf(node: FNode): FNode {
  let n = node;
  while (n.parentNode) n = n.parentNode;
  return n;
}

function preorder(root: FNode): FNode[] {
  const out: FNode[] = [];
  const visit = (n: FNode) => {
    out.push(n);
    if (n instanceof FEl) n.childNodes.forEach(visit);
  };
  visit(root);
  return out;
}

function el(tag: string, attrs: Record<string, string>, ...kids: Array<FNode | string>): FEl {
  return new FEl(tag, attrs).append(...kids);
}

function run(body: FEl): void {
  const document = {
    body,
    createElement: (tag: string) => new FEl(tag),
    createTreeWalker: (root: FEl, what: number) => {
      const nodes = preorder(root).slice(1).filter((n) =>
        (n instanceof FText && what & 4) || (n instanceof FEl && what & 1));
      let i = 0;
      return { nextNode: () => nodes[i++] ?? null };
    },
  };
  const Node = { TEXT_NODE: 3, DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_CONTAINED_BY: 16 };
  const script = buildQuoteCollapseScript({ show: 'Show', hide: 'Hide' });
  new Function('document', 'Node', 'NodeFilter', 'window', script)(document, Node, { SHOW_ELEMENT: 1, SHOW_TEXT: 4 }, {});
}

const hidden = (e: FEl) => e.hasAttribute(QUOTE_COLLAPSED_ATTR) && e.style.display === 'none';
const toggled = (body: FEl) => preorder(body).some((n) => n instanceof FEl && n.hasAttribute(QUOTE_TOGGLE_ATTR));

describe('quote collapse for iPhone Mail and Outlook (#1476)', () => {
  it("folds Outlook for Windows' header block marked only by its top rule, and what follows", () => {
    const header = el('div', { style: 'border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm' }, el('p', {}, 'From: Bob'));
    const original = el('p', {}, 'the original');
    const body = el('body', {}, el('p', {}, 'My reply'), header, original);
    run(body);
    expect(hidden(header)).toBe(true);
    expect(hidden(original)).toBe(true);
    expect(toggled(body)).toBe(true);

    const old = el('div', { style: 'BORDER-TOP: solid #B5C4DF 1pt' }, 'From: Bob');
    const body2 = el('body', {}, el('p', {}, 'Reply'), old);
    run(body2);
    expect(hidden(old)).toBe(true);
  });

  it("folds Outlook mobile's reference container", () => {
    const ref = el('div', { id: 'mail-editor-reference-message-container' }, el('p', {}, 'From: Bob'), el('p', {}, 'old'));
    const body = el('body', {}, el('div', {}, 'Sent from Outlook for iOS'), ref);
    run(body);
    expect(hidden(ref)).toBe(true);
  });

  it("folds iPhone Mail's attribution blockquote and the original after it", () => {
    const attribution = el('blockquote', { type: 'cite' }, 'On 10 Nov 2026, at 09:00, Bob wrote:');
    const original = el('blockquote', { type: 'cite' }, el('div', {}, 'the original'));
    const body = el('body', {}, el('div', {}, 'Sounds good'), el('div', {}, el('br', {})), attribution, original);
    run(body);
    expect(hidden(attribution)).toBe(true);
    expect(hidden(original)).toBe(true);
  });

  it('still leaves an interleaved reply alone', () => {
    const quote = el('blockquote', { type: 'cite' }, 'question?');
    const body = el('body', {}, el('p', {}, 'Hi'), quote, el('p', {}, 'my answer'));
    run(body);
    expect(hidden(quote)).toBe(false);
    expect(toggled(body)).toBe(false);
  });
});
