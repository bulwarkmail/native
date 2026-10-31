import { describe, it, expect } from 'vitest';
import { buildQuoteCollapseScript, QUOTE_COLLAPSED_ATTR, QUOTE_TOGGLE_ATTR } from '../quote-collapse';

// The reader's quote-collapse script looked for an attributed <blockquote>
// by walking every text node from the start of the body once per top-level
// blockquote: quadratic, so a mail full of blockquotes froze the reader. The
// webmail does one walk (lib/quote-collapse.ts). These tests run the injected
// script against a small fake DOM that counts the tree-walker steps.

const SHOW_ELEMENT = 1;
const SHOW_TEXT = 4;

let steps = 0;

class FNode {
  parentNode: FEl | null = null;
  get parentElement(): FEl | null { return this.parentNode; }
}

class FText extends FNode {
  nodeType = 3;
  constructor(public nodeValue: string) { super(); }
}

class FEl extends FNode {
  nodeType = 1;
  tagName: string;
  childNodes: FNode[] = [];
  attrs = new Map<string, string>();
  style = { display: '', cssText: '' };
  title = '';
  textContent = '';
  constructor(tag: string) { super(); this.tagName = tag.toUpperCase(); }
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
  matches() { return false; }
  // The fixtures hold no element the container or separator selectors match.
  querySelector() { return null; }
  querySelectorAll(tag: string): FEl[] {
    return preorder(this).slice(1).filter((n): n is FEl => n instanceof FEl && n.tagName === tag.toUpperCase());
  }
  closest(tag: string): FEl | null {
    for (let el: FEl | null = this; el; el = el.parentNode) if (el.tagName === tag.toUpperCase()) return el;
    return null;
  }
  compareDocumentPosition(other: FNode): number {
    for (let p = other.parentNode; p; p = p.parentNode) if (p === this) return 16 | 4; // contained by, following
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

function el(tag: string, ...kids: Array<FNode | string>): FEl {
  return new FEl(tag).append(...kids);
}

function run(body: FEl): void {
  const document = {
    body,
    createElement: (tag: string) => new FEl(tag),
    createTreeWalker: (root: FEl, what: number) => {
      const nodes = preorder(root).slice(1).filter((n) =>
        (n instanceof FText && what & SHOW_TEXT) || (n instanceof FEl && what & SHOW_ELEMENT));
      let i = 0;
      return { nextNode: () => { steps++; return nodes[i++] ?? null; } };
    },
  };
  const Node = {
    TEXT_NODE: 3, DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_CONTAINED_BY: 16,
  };
  const NodeFilter = { SHOW_ELEMENT, SHOW_TEXT };
  const script = buildQuoteCollapseScript({ show: 'Show', hide: 'Hide' });
  new Function('document', 'Node', 'NodeFilter', 'window', script)(document, Node, NodeFilter, {});
}

describe('quote collapse in HTML mail', () => {
  it('finds the attributed blockquote in one walk, not one walk per blockquote', () => {
    const n = 300;
    const body = el('body');
    for (let i = 0; i < n; i++) body.append(el('p', `line ${i}`), el('blockquote', `quote ${i}`));
    steps = 0;
    run(body);
    // About 4n nodes in the body; walking from the start for each of the n
    // blockquotes took about n² steps.
    expect(steps).toBeLessThan(20 * n);
  });

  it('collapses the outermost blockquote after an attribution line', () => {
    const inner = el('blockquote', 'older');
    const outer = el('blockquote', el('p', 'old'), inner);
    const first = el('blockquote', 'not attributed');
    const body = el('body', el('p', 'a'), first, el('p', 'Thanks!'), el('p', 'On Monday, Bob wrote:'), outer);
    run(body);
    expect(outer.style.display).toBe('none');
    expect(outer.hasAttribute(QUOTE_COLLAPSED_ATTR)).toBe(true);
    expect(first.style.display).toBe('');
    expect(inner.hasAttribute(QUOTE_COLLAPSED_ATTR)).toBe(false);
    const button = body.childNodes[body.childNodes.indexOf(outer) - 1] as FEl;
    expect(button.hasAttribute(QUOTE_TOGGLE_ATTR)).toBe(true);
  });

  it('leaves a blockquote alone when no attribution line precedes it', () => {
    const quote = el('blockquote', 'quoted');
    run(el('body', el('p', 'Hello there'), quote));
    expect(quote.style.display).toBe('');
  });
});
