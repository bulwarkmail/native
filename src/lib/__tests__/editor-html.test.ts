import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildEditorCsp, buildEditorHtml, CHANGE_THROTTLE_MS, PASTE_FALLBACK_MS, shouldBlockEditorRemoteImages,
} from '../editor-html';
import { PLAIN_PASTE_MAX_CHARS } from '../plain-text-paste';
import { LIGHT_COLORS, DARK_COLORS } from '../../theme/tokens';

function extractScript(html: string): string {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  expect(m, 'page must contain an inline <script>').toBeTruthy();
  return m![1];
}

describe('buildEditorHtml', () => {
  const base = { initialHtml: '<p><br></p>', placeholder: 'Write…', c: LIGHT_COLORS };

  // Regression for issue #11: backslash escapes inside the template literal
  // are cooked away (`\/` → `/`), which once emitted an invalid regex. That
  // SyntaxError killed the entire inline script, so the editor never posted
  // `change` messages and Send stayed disabled on Android/iOS.
  it('emits an inline script that parses as valid JavaScript', () => {
    for (const c of [LIGHT_COLORS, DARK_COLORS]) {
      const script = extractScript(buildEditorHtml({ ...base, c }));
      // new Function() parses without executing (script needs a DOM to run).
      expect(() => new Function(script)).not.toThrow();
    }
  });

  it('emits no cooked-away backslashes in the script', () => {
    // The page script is written escape-free on purpose; a backslash-free
    // source cannot silently lose escapes to template-literal cooking.
    const script = extractScript(buildEditorHtml(base));
    expect(script).not.toContain('\\');
  });

  it('embeds initial content and placeholder as JSON strings', () => {
    const html = buildEditorHtml({
      ...base,
      initialHtml: '<p>He said "hi" & left</p>',
      placeholder: 'Say "something"…',
    });
    expect(html).toContain(JSON.stringify('<p>He said "hi" & left</p>'));
    expect(html).toContain(`data-placeholder=${JSON.stringify('Say "something"…')}`);
  });

  it('keeps the editor contenteditable and the bridge object wiring', () => {
    const html = buildEditorHtml(base);
    expect(html).toContain('<div id="editor" contenteditable="true"');
    const script = extractScript(html);
    expect(script).toContain('window.__rne');
    expect(script).toContain('ReactNativeWebView.postMessage');
  });

  // Regression for issue #9: sends must be able to read the live DOM back
  // instead of trusting async `change` messages that can lag or be lost.
  it('exposes the send-time getHtml readback on the bridge', () => {
    const script = extractScript(buildEditorHtml(base));
    expect(script).toContain('getHtml: function (id)');
    expect(script).toContain("post('htmlSnapshot', { id: id, html: editor.innerHTML })");
  });
});

describe('editor CSP', () => {
  const base = { initialHtml: '<p><br></p>', placeholder: 'Write…', c: LIGHT_COLORS };

  function cspOf(html: string): string {
    const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/);
    expect(m, 'page must carry a CSP meta').toBeTruthy();
    return m![1];
  }

  it('puts the policy in the head before any content', () => {
    const html = buildEditorHtml(base);
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<body>'));
    expect(cspOf(html)).toContain("default-src 'none'");
    expect(cspOf(html)).toContain("script-src 'unsafe-inline'");
  });

  it('blocks remote images and fonts but keeps data: and blob: images', () => {
    const csp = cspOf(buildEditorHtml({ ...base, blockRemoteImages: true }));
    expect(csp).toContain('img-src data: blob:;');
    expect(csp).not.toMatch(/https?:/);
    expect(csp).toContain('font-src data:;');
  });

  it('allows remote images when not blocking', () => {
    expect(buildEditorCsp(false)).toContain('img-src data: blob: https: http:');
    expect(cspOf(buildEditorHtml(base))).toBe(buildEditorCsp(false));
  });
});

describe('shouldBlockEditorRemoteImages', () => {
  const quote = '<p>hi</p><img src="https://tracker.example/p.gif">';

  it('blocks a quoted original from an untrusted sender', () => {
    expect(shouldBlockEditorRemoteImages({
      seedHtml: quote, isDraft: false, externalContentPolicy: 'ask', senderTrusted: false,
    })).toBe(true);
    expect(shouldBlockEditorRemoteImages({
      seedHtml: quote, isDraft: false, externalContentPolicy: 'block', senderTrusted: false,
    })).toBe(true);
  });

  it('allows it for a trusted sender or the allow policy', () => {
    expect(shouldBlockEditorRemoteImages({
      seedHtml: quote, isDraft: false, externalContentPolicy: 'ask', senderTrusted: true,
    })).toBe(false);
    expect(shouldBlockEditorRemoteImages({
      seedHtml: quote, isDraft: false, externalContentPolicy: 'allow', senderTrusted: false,
    })).toBe(false);
  });

  it('allows a new message, which quotes nothing', () => {
    expect(shouldBlockEditorRemoteImages({
      seedHtml: undefined, isDraft: false, externalContentPolicy: 'block', senderTrusted: false,
    })).toBe(false);
  });

  it('blocks a reopened draft only when it carries a quote', () => {
    const opts = { isDraft: true, externalContentPolicy: 'ask' as const, senderTrusted: true };
    expect(shouldBlockEditorRemoteImages({ ...opts, seedHtml: '<p>Hi</p><div data-quoted-html="true">x</div>' })).toBe(true);
    expect(shouldBlockEditorRemoteImages({ ...opts, seedHtml: '<p>Hi</p><blockquote>x</blockquote>' })).toBe(true);
    expect(shouldBlockEditorRemoteImages({ ...opts, seedHtml: '<p>Hi</p><img src="https://me.example/logo.png">' })).toBe(false);
  });
});

// Runs the page script against a minimal fake DOM to check what it posts to
// RN while the user types (PF8: each post re-renders the whole composer).
describe('editor page messages', () => {
  type Listener = (event?: unknown) => void;
  function boot() {
    const listeners: Record<string, Listener[]> = {};
    const docListeners: Record<string, Listener[]> = {};
    const posted: Array<{ type: string; payload: unknown }> = [];
    type FakeNode = {
      nodeType?: number; tagName?: string; data?: string; parentNode?: unknown; previousSibling?: FakeNode; lastChild?: FakeNode;
    };
    // The editor holds either markup set as a whole or one text node (for
    // the @-mention tests), serialized as the DOM would: text escaped.
    let html = '';
    let textNode: FakeNode | null = null;
    const focusCalls = { value: 0 };
    /** What went in at a saved range without execCommand (the editor was not focused). */
    const insertedAtRange: Array<{ range: unknown; content: unknown }> = [];
    const editor = {
      get innerHTML() {
        return textNode ? textNode.data!.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : html;
      },
      set innerHTML(value: string) { html = value; textNode = null; },
      get textContent() { return this.innerHTML.replace(/<[^>]*>/g, ''); },
      scrollHeight: 100,
      querySelector: () => null,
      setAttribute: () => undefined,
      focus: () => { focusCalls.value++; },
      contains: (node: unknown) => {
        for (let n = node as FakeNode | undefined; n; n = n.parentNode as FakeNode | undefined) {
          if (n === (editor as unknown)) return true;
        }
        return false;
      },
      addEventListener: (name: string, fn: Listener) => { (listeners[name] ??= []).push(fn); },
    };
    // The caret: a range in the editor that the page saves on paste and
    // restores before inserting.
    const caret = { startContainer: editor as unknown, id: 'caret' };
    const ranges: unknown[] = [caret];
    type FakeRange = {
      startContainer?: unknown; startOffset?: number; endContainer?: unknown; endOffset?: number; id?: string;
    };
    const collapsedRange = (r: FakeRange) =>
      r.endContainer === undefined || (r.endContainer === r.startContainer && r.endOffset === r.startOffset);
    const selection = {
      get rangeCount() { return ranges.length; },
      anchorNode: null,
      getRangeAt: () => {
        const r = ranges[0] as FakeRange;
        return {
          ...r,
          collapsed: collapsedRange(r),
          cloneRange: () => {
            const saved: Record<string, unknown> = {
              ...r,
              id: 'saved',
              createContextualFragment: (markup: string) => ({ markup }),
              deleteContents: () => undefined,
              insertNode: (content: unknown) => { insertedAtRange.push({ range: saved, content }); },
            };
            return saved;
          },
        };
      },
      removeAllRanges: () => { ranges.length = 0; },
      addRange: (r: unknown) => { ranges.push(r); },
    };
    const caretAt = (node: unknown, offset: number) => {
      ranges.length = 0;
      ranges.push({ startContainer: node, startOffset: offset });
    };
    const executed: Array<{ command: string; value: unknown; range: unknown }> = [];
    const commandState: Record<string, boolean> = {};
    /** What execCommand returns; false plays a WebView where it does nothing. */
    const execWorks = { value: true };
    const document = {
      activeElement: editor as unknown,
      getElementById: () => editor,
      addEventListener: (name: string, fn: Listener) => { (docListeners[name] ??= []).push(fn); },
      queryCommandState: (name: string) => !!commandState[name],
      createDocumentFragment: () => {
        const children: unknown[] = [];
        return { children, appendChild: (child: unknown) => { children.push(child); } };
      },
      createTextNode: (data: string) => ({ nodeType: 3, data }),
      createElement: (tag: string) => ({ nodeType: 1, tagName: tag.toUpperCase() }),
      createRange: () => {
        const r: FakeRange & Record<string, unknown> = {
          setStart(node: unknown, offset: number) { r.startContainer = node; r.startOffset = offset; },
          setEnd(node: unknown, offset: number) { r.endContainer = node; r.endOffset = offset; },
          collapse() { r.endContainer = r.startContainer; r.endOffset = r.startOffset; },
        };
        return r;
      },
      execCommand: (command: string, _ui: boolean, value: unknown) => {
        const range = ranges[0] as FakeRange | undefined;
        executed.push({ command, value, range: range && { ...range } });
        if (!execWorks.value) return false;
        // insertText over a selection in a text node, as the browser does it.
        const node = range?.startContainer as FakeNode | undefined;
        if (command === 'insertText' && node?.nodeType === 3 && (range!.endContainer ?? node) === node) {
          const end = range!.endContainer === undefined ? range!.startOffset : range!.endOffset;
          node.data = node.data!.slice(0, range!.startOffset) + String(value) + node.data!.slice(end);
          caretAt(node, range!.startOffset! + String(value).length);
        }
        return true;
      },
    };
    const window = {
      ReactNativeWebView: { postMessage: (msg: string) => posted.push(JSON.parse(msg)) },
      addEventListener: () => undefined,
      getSelection: () => selection,
      __rne: undefined as unknown as Record<string, (...args: unknown[]) => void>,
    };
    const script = extractScript(buildEditorHtml({ initialHtml: '<p><br></p>', placeholder: '', c: LIGHT_COLORS }));
    new Function('window', 'document', script)(window, document);
    const changes = () => posted.filter((m) => m.type === 'change').map((m) => m.payload);
    const selections = () => posted.filter((m) => m.type === 'selection');
    const mentions = () => posted.filter((m) => m.type === 'mention').map((m) => m.payload);
    /**
     * Makes the editor one text node (inside `parent`, if given, and after
     * `previous`) with the caret at `caret` (default: its end), as if the
     * user typed it.
     */
    const typeText = (data: string, opts: { parent?: FakeNode; previous?: FakeNode; caret?: number } = {}) => {
      if (opts.parent) opts.parent.parentNode = editor;
      const node: FakeNode = textNode?.data !== undefined && !opts.parent && textNode.parentNode === editor
        ? textNode
        : { nodeType: 3, parentNode: opts.parent ?? editor };
      node.data = data;
      if (opts.previous) node.previousSibling = opts.previous;
      textNode = node;
      caretAt(node, opts.caret ?? data.length);
      listeners.input.forEach((fn) => fn());
      return node;
    };
    const pastes = () => posted.filter((m) => m.type === 'pastePlain').map((m) => (m.payload as { text: string }).text);
    /** The id the page gave its latest paste, which RN's answer must carry. */
    const lastPasteId = () => (posted.filter((m) => m.type === 'pastePlain').pop()!.payload as { id: number }).id;
    const type = (html: string) => { editor.innerHTML = html; listeners.input.forEach((fn) => fn()); };
    const fire = (name: string) => (listeners[name] ?? docListeners[name]).forEach((fn) => fn());
    /** Fires a paste with the given clipboard; returns whether the page took it over. */
    const paste = (clipboard: Record<string, string>) => {
      let prevented = false;
      const event = {
        clipboardData: { getData: (type: string) => clipboard[type] ?? '' },
        preventDefault: () => { prevented = true; },
      };
      listeners.paste.forEach((fn) => fn(event));
      return prevented;
    };
    /** Moves the caret somewhere else, as the user would while the paste is in flight. */
    const moveCaret = () => { ranges.length = 0; ranges.push({ startContainer: editor, id: 'moved' }); };
    return {
      changes, selections, pastes, lastPasteId, type, fire, paste, moveCaret, commandState, posted, executed,
      mentions, typeText, caretAt, execWorks, document, caret: () => ranges[0] as FakeRange, rne: () => window.__rne,
      focusCalls, insertedAtRange,
    };
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('posts the first keystroke at once and then at most one change per window', () => {
    const page = boot();
    const before = page.changes().length;
    page.type('<p>H</p>');
    expect(page.changes().slice(before)).toEqual(['<p>H</p>']);
    page.type('<p>He</p>');
    page.type('<p>Hel</p>');
    expect(page.changes().slice(before)).toEqual(['<p>H</p>']);
    vi.advanceTimersByTime(CHANGE_THROTTLE_MS);
    expect(page.changes().slice(before)).toEqual(['<p>H</p>', '<p>Hel</p>']);
  });

  it('flushes a pending change on blur', () => {
    const page = boot();
    page.type('<p>A</p>');
    page.type('<p>AB</p>');
    page.fire('blur');
    expect(page.changes().slice(-1)).toEqual(['<p>AB</p>']);
    vi.advanceTimersByTime(CHANGE_THROTTLE_MS * 2);
    expect(page.changes().filter((c) => c === '<p>AB</p>')).toHaveLength(1);
  });

  it('posts the selection state only when the formatting changes', () => {
    const page = boot();
    page.fire('selectionchange');
    page.fire('selectionchange');
    expect(page.selections()).toHaveLength(1);
    page.commandState.bold = true;
    page.fire('selectionchange');
    expect(page.selections()).toHaveLength(2);
    expect((page.selections()[1].payload as { bold: boolean }).bold).toBe(true);
  });

  // Task 9: a plain-text list is handed to RN, which parses it and sends back
  // the HTML. Anything else keeps the WebView's own paste.
  describe('plain-text paste', () => {
    it('leaves a clipboard that carries HTML to the default paste', () => {
      const page = boot();
      expect(page.paste({ 'text/html': '<ul><li>One</li></ul>', 'text/plain': '- One' })).toBe(false);
      expect(page.pastes()).toEqual([]);
    });

    it('leaves plain text without a list to the default paste', () => {
      const page = boot();
      const blanks = ['- \u000b', '- \f', '1. \u00a0', '* \u2028', '- \u2029', '- \u3000'];
      for (const text of ['Hello there', 'Costs - roughly\n-- \nLinus', '-x\n1.5 litres\n1234. no', '- ', '', ...blanks]) {
        expect(page.paste({ 'text/plain': text })).toBe(false);
      }
      expect(page.pastes()).toEqual([]);
    });

    it('hands a plain-text list to RN instead of pasting it', () => {
      for (const text of ['intro\n- One', '  * One', '\t\u2022 One', '12) One', 'x\r\n1.\tOne']) {
        const page = boot();
        expect(page.paste({ 'text/plain': text }), text).toBe(true);
        expect(page.pastes()).toEqual([text]);
        expect(page.lastPasteId()).toEqual(expect.any(Number));
        expect(page.executed).toEqual([]);
      }
    });

    it('leaves a paste above the size cap to the default paste', () => {
      const page = boot();
      expect(page.paste({ 'text/plain': `- a\n${'x'.repeat(PLAIN_PASTE_MAX_CHARS)}` })).toBe(false);
    });

    it('inserts the returned HTML at the range saved when the paste happened', () => {
      const page = boot();
      page.paste({ 'text/plain': '- One' });
      page.moveCaret();
      const before = page.changes().length;
      page.rne().insertPasted('<ul><li>One</li></ul>', page.lastPasteId());
      expect(page.executed).toEqual([
        { command: 'insertHTML', value: '<ul><li>One</li></ul>', range: expect.objectContaining({ id: 'saved' }) },
      ]);
      expect(page.changes().length).toBeGreaterThanOrEqual(before);
    });

    it('inserts the text as text when RN found no list', () => {
      const page = boot();
      page.paste({ 'text/plain': '- <b>x</b>' });
      page.rne().insertPasted(null, page.lastPasteId());
      expect(page.executed).toEqual([
        { command: 'insertText', value: '- <b>x</b>', range: expect.objectContaining({ id: 'saved' }) },
      ]);
    });

    it('pastes the text itself when RN never answers, and ignores a late answer', () => {
      const page = boot();
      page.paste({ 'text/plain': '- One' });
      const id = page.lastPasteId();
      vi.advanceTimersByTime(PASTE_FALLBACK_MS);
      expect(page.executed).toEqual([
        { command: 'insertText', value: '- One', range: expect.objectContaining({ id: 'saved' }) },
      ]);
      page.rne().insertPasted('<ul><li>One</li></ul>', id);
      expect(page.executed).toHaveLength(1);
    });

    it('ignores an answer for a paste it is not waiting on', () => {
      const page = boot();
      page.rne().insertPasted('<script>x</script>', 1);
      page.paste({ 'text/plain': '- One' });
      const first = page.lastPasteId();
      vi.advanceTimersByTime(PASTE_FALLBACK_MS);
      page.paste({ 'text/plain': '- Two' });
      page.rne().insertPasted('<ul><li>One</li></ul>', first);
      expect(page.executed.map((e) => e.value)).toEqual(['- One']);
      page.rne().insertPasted('<ul><li>Two</li></ul>', page.lastPasteId());
      expect(page.executed.map((e) => e.value)).toEqual(['- One', '<ul><li>Two</li></ul>']);
      vi.advanceTimersByTime(PASTE_FALLBACK_MS);
      expect(page.executed).toHaveLength(2);
    });

    // The user moved on to Subject or To while RN worked: focusing the
    // editor to paste would pull them back.
    it('pastes at the saved range without taking focus once the editor lost it', () => {
      const page = boot();
      page.paste({ 'text/plain': '- One' });
      page.fire('blur');
      page.rne().insertPasted('<ul><li>One</li></ul>', page.lastPasteId());
      expect(page.executed).toEqual([]);
      expect(page.focusCalls.value).toBe(0);
      expect(page.insertedAtRange).toEqual([
        { range: expect.objectContaining({ id: 'saved' }), content: { markup: '<ul><li>One</li></ul>' } },
      ]);
    });

    it('pastes the text as text, line by line, without taking focus once the editor lost it', () => {
      const page = boot();
      page.paste({ 'text/plain': '- <b>One</b>\r\n- Two' });
      page.fire('blur');
      vi.advanceTimersByTime(PASTE_FALLBACK_MS);
      expect(page.executed).toEqual([]);
      expect(page.focusCalls.value).toBe(0);
      expect(page.insertedAtRange.map((i) => (i.content as { children: unknown[] }).children)).toEqual([[
        { nodeType: 3, data: '- <b>One</b>' },
        { nodeType: 1, tagName: 'BR' },
        { nodeType: 3, data: '- Two' },
      ]]);
    });

    it('focuses the editor to paste while the user is still in it', () => {
      const page = boot();
      page.paste({ 'text/plain': '- One' });
      page.fire('blur');
      page.fire('focus');
      page.rne().insertPasted(null, page.lastPasteId());
      expect(page.executed.map((e) => e.command)).toEqual(['insertText']);
      expect(page.insertedAtRange).toEqual([]);
    });

    it('settles a paste still in flight as text before taking the next one', () => {
      const page = boot();
      page.paste({ 'text/plain': '- One' });
      page.paste({ 'text/plain': '- Two' });
      expect(page.executed.map((e) => [e.command, e.value])).toEqual([['insertText', '- One']]);
    });
  });

  // Task 10: "@" at the start of a word asks RN for the recipients; RN sends
  // back the chosen label, which goes in as text.
  describe('@-mention', () => {
    it('posts the query for an @ at the start of a word', () => {
      const page = boot();
      page.typeText('Hi @');
      page.typeText('Hi @ma');
      expect(page.mentions()).toEqual([{ query: '' }, { query: 'ma' }]);
      for (const text of ['@jo', 'Hi\u00a0@jo']) {
        const other = boot();
        other.typeText(text);
        expect(other.mentions(), text).toEqual([{ query: 'jo' }]);
      }
    });

    it('posts nothing for an @ inside a word, in code, pre or a link', () => {
      const page = boot();
      page.typeText('info@x');
      page.typeText('a.b@dornig');
      expect(page.mentions()).toEqual([]);
      for (const tagName of ['CODE', 'PRE', 'A']) {
        const other = boot();
        other.typeText('Hi @ma', { parent: { nodeType: 1, tagName } });
        expect(other.mentions(), tagName).toEqual([]);
      }
    });

    it('posts the query only when it changes, and null when the run ends', () => {
      const page = boot();
      page.typeText('Hi @ma');
      page.fire('selectionchange');
      expect(page.mentions()).toEqual([{ query: 'ma' }]);
      page.typeText('Hi @ma ');
      expect(page.mentions()).toEqual([{ query: 'ma' }, null]);
      page.typeText('Hi @ma x');
      expect(page.mentions()).toEqual([{ query: 'ma' }, null]);
    });

    it('posts null when the caret leaves the run or the editor loses focus', () => {
      const page = boot();
      const node = page.typeText('Hi @ma');
      page.caretAt(node, 2);
      page.fire('selectionchange');
      expect(page.mentions()).toEqual([{ query: 'ma' }, null]);
      page.typeText('Hi @ma');
      page.fire('blur');
      expect(page.mentions()).toEqual([{ query: 'ma' }, null, { query: 'ma' }, null]);
      expect(page.posted.at(-1)).toEqual({ type: 'blur', payload: null });
    });

    it('replaces the run with the label as literal text and posts the change', () => {
      const page = boot();
      const node = page.typeText('Hi @ma');
      const before = page.changes().length;
      page.rne().insertMention('<b>Max</b>');
      expect(page.executed).toEqual([{
        command: 'insertText', value: '@<b>Max</b> ', range: expect.objectContaining({ startOffset: 3, endOffset: 6 }),
      }]);
      expect(node.data).toBe('Hi @<b>Max</b> ');
      expect(page.changes().slice(before)).toEqual(['Hi @&lt;b&gt;Max&lt;/b&gt; ']);
      expect(page.mentions().at(-1)).toBeNull();
    });

    it('adds no space when one follows, and puts the caret past it', () => {
      const page = boot();
      const node = page.typeText('Hi @ma there', { caret: 6 });
      page.rne().insertMention('Max');
      expect(node.data).toBe('Hi @Max there');
      expect(page.caret()).toEqual(expect.objectContaining({ startContainer: node, startOffset: 8 }));
    });

    // A tap on RN's list can blur the editor before the pick arrives.
    it('still inserts after a blur closed the list', () => {
      const page = boot();
      const node = page.typeText('Hi @ma');
      page.fire('blur');
      expect(page.mentions().at(-1)).toBeNull();
      page.rne().insertMention('Max');
      expect(node.data).toBe('Hi @Max ');
    });

    it('reads an @ at the start of a text node against the text before it in the block', () => {
      const text = (data: string) => ({ nodeType: 3, data });
      const cases: Array<[string, Parameters<ReturnType<typeof boot>['typeText']>[1], unknown[]]> = [
        // info<b>@x</b>
        ['bold after a word', { parent: { nodeType: 1, tagName: 'B', previousSibling: text('info') } }, []],
        // <span>info</span>@x
        ['after an inline word', { previous: { nodeType: 1, tagName: 'SPAN', lastChild: text('info') } }, []],
        // Hi <b>@x</b>
        ['bold after a space', { parent: { nodeType: 1, tagName: 'B', previousSibling: text('Hi ') } }, [{ query: 'x' }]],
        // <p>info</p>@x
        ['after another block', { previous: { nodeType: 1, tagName: 'P', lastChild: text('info') } }, [{ query: 'x' }]],
        // info<br>@x
        ['after a line break', { previous: { nodeType: 1, tagName: 'BR', previousSibling: text('info') } }, [{ query: 'x' }]],
        ...['SECTION', 'ARTICLE', 'ASIDE', 'HEADER', 'FOOTER', 'NAV', 'FIGURE', 'FIGCAPTION', 'ADDRESS', 'DL', 'DT', 'DD',
          'TFOOT', 'CAPTION'].map((tagName): [string, Parameters<ReturnType<typeof boot>['typeText']>[1], unknown[]] =>
          [`after a ${tagName}`, { previous: { nodeType: 1, tagName, lastChild: text('info') } }, [{ query: 'x' }]]),
      ];
      for (const [name, opts, expected] of cases) {
        const page = boot();
        page.typeText('@x', opts);
        expect(page.mentions(), name).toEqual(expected);
      }
    });

    it('writes the text node itself where insertText does nothing', () => {
      const page = boot();
      const node = page.typeText('Hi @ma');
      page.execWorks.value = false;
      page.rne().insertMention('<b>Max</b>');
      expect(node.data).toBe('Hi @<b>Max</b> ');
      expect(page.executed.map((e) => e.command)).toEqual(['insertText']);
      expect(page.changes().at(-1)).toBe('Hi @&lt;b&gt;Max&lt;/b&gt; ');
    });

    it('replaces the whole run when the user typed on, and nothing once the @ is gone', () => {
      const page = boot();
      page.typeText('Hi @ma');
      page.typeText('Hi @max');
      page.rne().insertMention('Max');
      expect(page.executed.map((e) => e.value)).toEqual(['@Max ']);

      const gone = boot();
      const node = gone.typeText('Hi @ma');
      node.data = 'Hi ma';
      gone.rne().insertMention('Max');
      expect(gone.executed).toEqual([]);
      expect(node.data).toBe('Hi ma');
    });

    it('puts a paste still waiting for RN in first, as text, then the mention after it', () => {
      const page = boot();
      const node = page.typeText('Hi ');
      page.paste({ 'text/plain': '- One' });
      page.typeText('Hi @ma');
      const id = page.lastPasteId();
      page.rne().insertMention('Max');
      expect(page.executed.map((e) => [e.command, e.value])).toEqual([['insertText', '- One'], ['insertText', '@Max ']]);
      expect(node.data).toBe('Hi - One@Max ');
      // RN's late answer and the fallback timer find nothing to paste.
      page.rne().insertPasted('<ul><li>One</li></ul>', id);
      vi.advanceTimersByTime(PASTE_FALLBACK_MS);
      expect(page.executed).toHaveLength(2);
    });

    it('does nothing without an open run', () => {
      const page = boot();
      page.typeText('info@x');
      page.rne().insertMention('Max');
      expect(page.executed).toEqual([]);
    });
  });
});
