import { describe, expect, it } from 'vitest';
import { buildEditorHtml, MENTION_QUERY_SOURCE } from '../editor-html';
import { LIGHT_COLORS } from '../../theme/tokens';

// "@" mentions in the composer's editor page (webmail #1134): the page
// reports the "@..." being typed and swaps it for a mention link on request.

function extractScript(html: string): string {
  const m = html.match(/<script(?: nonce="[0-9a-f]+")?>([\s\S]*?)<\/script>/);
  return m![1];
}

const mentionQueryIn = new Function(`${MENTION_QUERY_SOURCE}; return mentionQueryIn;`)() as
  (text: string) => { at: number; query: string } | null;

describe('mentionQueryIn', () => {
  it('starts at an @ at the start of a word', () => {
    expect(mentionQueryIn('@')).toEqual({ at: 0, query: '' });
    expect(mentionQueryIn('Hi @ma')).toEqual({ at: 3, query: 'ma' });
    expect(mentionQueryIn(`Hi${String.fromCharCode(160)}@jü`)).toEqual({ at: 3, query: 'jü' });
  });

  it('never starts inside an address, and ends at a space', () => {
    expect(mentionQueryIn('info@example')).toBeNull();
    expect(mentionQueryIn('Hi @max and')).toBeNull();
    expect(mentionQueryIn('no at sign')).toBeNull();
  });
});

interface FakeNode { nodeType: number; tagName?: string; data?: string; parentNode?: unknown; textContent?: string; attrs?: Record<string, string> }

function boot(mentions: boolean) {
  const listeners: Record<string, Array<() => void>> = {};
  const docListeners: Record<string, Array<() => void>> = {};
  const posted: Array<{ type: string; payload: unknown }> = [];
  const ops: string[] = [];
  const editor = {
    nodeType: 1,
    tagName: 'DIV',
    innerHTML: '',
    get textContent() { return this.innerHTML.replace(/<[^>]*>/g, ''); },
    scrollHeight: 100,
    querySelector: () => null,
    setAttribute: () => undefined,
    focus: () => undefined,
    addEventListener: (name: string, fn: () => void) => { (listeners[name] ??= []).push(fn); },
  };
  const text: FakeNode = { nodeType: 3, data: 'Hi @ma', parentNode: editor };
  let selection = { rangeCount: 1, isCollapsed: true, anchorNode: text as unknown, anchorOffset: 6 };
  const range = {
    setStart: (n: FakeNode, o: number) => ops.push(`start ${n === text ? 'text' : '?'} ${o}`),
    setEnd: (n: FakeNode, o: number) => ops.push(`end ${n === text ? 'text' : '?'} ${o}`),
    deleteContents: () => ops.push('delete'),
    insertNode: (n: FakeNode) => ops.push(`insert ${n.tagName ?? JSON.stringify(n.data)}`),
    setStartAfter: (n: FakeNode) => ops.push(`caret after ${n.tagName ?? JSON.stringify(n.data)}`),
    collapse: () => undefined,
  };
  const created: FakeNode[] = [];
  const document = {
    activeElement: editor as unknown,
    getElementById: () => editor,
    addEventListener: (name: string, fn: () => void) => { (docListeners[name] ??= []).push(fn); },
    queryCommandState: () => false,
    createRange: () => range,
    createElement: (tag: string) => {
      const el: FakeNode = { nodeType: 1, tagName: tag.toUpperCase(), attrs: {} };
      (el as unknown as { setAttribute: (k: string, v: string) => void }).setAttribute = (k, v) => { el.attrs![k] = v; };
      created.push(el);
      return el;
    },
    createTextNode: (data: string) => ({ nodeType: 3, data }),
  };
  const window: Record<string, unknown> = {
    ReactNativeWebView: { postMessage: (msg: string) => posted.push(JSON.parse(msg)) },
    addEventListener: () => undefined,
    getSelection: () => ({ ...selection, removeAllRanges: () => ops.push('clear'), addRange: () => ops.push('add range') }),
  };
  const script = extractScript(buildEditorHtml({ initialHtml: '<p><br></p>', placeholder: '', c: LIGHT_COLORS, mentions }));
  new Function('window', 'document', script)(window, document);
  const mentionsPosted = () => posted.filter((m) => m.type === 'mention').map((m) => m.payload);
  const input = () => listeners.input.forEach((fn) => fn());
  const blur = () => listeners.blur.forEach((fn) => fn());
  const setCaret = (data: string, offset = data.length) => {
    text.data = data;
    selection = { ...selection, anchorOffset: offset };
  };
  const bridge = window.__rne as { insertMention: (label: string, href: string) => void };
  return { mentionsPosted, input, blur, setCaret, bridge, ops, created, text };
}

describe('editor page mentions', () => {
  it('reports what follows the @ while it is typed, and null once it ends', () => {
    const page = boot(true);
    page.input();
    page.setCaret('Hi @max');
    page.input();
    page.setCaret('Hi @max ');
    page.input();
    expect(page.mentionsPosted()).toEqual(['ma', 'max', null]);
  });

  it('closes the list when the editor loses focus', () => {
    const page = boot(true);
    page.input();
    page.blur();
    expect(page.mentionsPosted()).toEqual(['ma', null]);
  });

  it('replaces the typed @query with a mailto link and a space, caret after it', () => {
    const page = boot(true);
    page.bridge.insertMention('Max <b>', 'mailto:max@dornig.de');
    expect(page.ops).toEqual([
      'start text 3', 'end text 6', 'delete',
      `insert ${JSON.stringify(String.fromCharCode(160))}`, 'insert A',
      `caret after ${JSON.stringify(String.fromCharCode(160))}`, 'clear', 'add range',
    ]);
    const [link] = page.created;
    expect(link.attrs).toEqual({ href: 'mailto:max@dornig.de', class: 'mention' });
    // The label goes in as text, never as markup.
    expect(link.textContent).toBe('@Max <b>');
  });

  it('does nothing in editors that are not a message', () => {
    const page = boot(false);
    page.input();
    page.bridge.insertMention('Max', 'mailto:max@dornig.de');
    expect(page.mentionsPosted()).toEqual([]);
    expect(page.ops).toEqual([]);
  });
});
