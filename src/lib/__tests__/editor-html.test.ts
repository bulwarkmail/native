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
    const editor = {
      innerHTML: '',
      get textContent() { return this.innerHTML.replace(/<[^>]*>/g, ''); },
      scrollHeight: 100,
      querySelector: () => null,
      setAttribute: () => undefined,
      focus: () => undefined,
      contains: (node: unknown) => node === editor,
      addEventListener: (name: string, fn: Listener) => { (listeners[name] ??= []).push(fn); },
    };
    // The caret: a range in the editor that the page saves on paste and
    // restores before inserting.
    const caret = { startContainer: editor as unknown, id: 'caret' };
    const ranges: unknown[] = [caret];
    const selection = {
      get rangeCount() { return ranges.length; },
      anchorNode: null,
      getRangeAt: () => ({ cloneRange: () => ({ ...(ranges[0] as object), id: 'saved' }) }),
      removeAllRanges: () => { ranges.length = 0; },
      addRange: (r: unknown) => { ranges.push(r); },
    };
    const executed: Array<{ command: string; value: unknown; range: unknown }> = [];
    const commandState: Record<string, boolean> = {};
    const document = {
      activeElement: editor as unknown,
      getElementById: () => editor,
      addEventListener: (name: string, fn: Listener) => { (docListeners[name] ??= []).push(fn); },
      queryCommandState: (name: string) => !!commandState[name],
      execCommand: (command: string, _ui: boolean, value: unknown) => {
        executed.push({ command, value, range: ranges[0] });
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
    const pastes = () => posted.filter((m) => m.type === 'pastePlain').map((m) => m.payload);
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
      changes, selections, pastes, type, fire, paste, moveCaret, commandState, posted, executed, rne: () => window.__rne,
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
      for (const text of ['Hello there', 'Costs - roughly\n-- \nLinus', '-x\n1.5 litres\n1234. no', '- ', '']) {
        expect(page.paste({ 'text/plain': text })).toBe(false);
      }
      expect(page.pastes()).toEqual([]);
    });

    it('hands a plain-text list to RN instead of pasting it', () => {
      for (const text of ['intro\n- One', '  * One', '\t\u2022 One', '12) One', 'x\r\n1.\tOne']) {
        const page = boot();
        expect(page.paste({ 'text/plain': text }), text).toBe(true);
        expect(page.pastes()).toEqual([text]);
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
      page.rne().insertPasted('<ul><li>One</li></ul>', '- One');
      expect(page.executed).toEqual([
        { command: 'insertHTML', value: '<ul><li>One</li></ul>', range: expect.objectContaining({ id: 'saved' }) },
      ]);
      expect(page.changes().length).toBeGreaterThanOrEqual(before);
    });

    it('inserts the text as text when RN found no list', () => {
      const page = boot();
      page.paste({ 'text/plain': '- <b>x</b>' });
      page.rne().insertPasted(null, '- <b>x</b>');
      expect(page.executed).toEqual([
        { command: 'insertText', value: '- <b>x</b>', range: expect.objectContaining({ id: 'saved' }) },
      ]);
    });

    it('pastes the text itself when RN never answers, and ignores a late answer', () => {
      const page = boot();
      page.paste({ 'text/plain': '- One' });
      vi.advanceTimersByTime(PASTE_FALLBACK_MS);
      expect(page.executed).toEqual([
        { command: 'insertText', value: '- One', range: expect.objectContaining({ id: 'saved' }) },
      ]);
      page.rne().insertPasted('<ul><li>One</li></ul>', '- One');
      expect(page.executed).toHaveLength(1);
    });

    it('ignores an answer for a paste it is not waiting on', () => {
      const page = boot();
      page.rne().insertPasted('<script>x</script>', 'nothing pasted');
      page.paste({ 'text/plain': '- Two' });
      page.rne().insertPasted('<ul><li>One</li></ul>', '- One');
      expect(page.executed).toEqual([]);
      page.rne().insertPasted('<ul><li>Two</li></ul>', '- Two');
      expect(page.executed.map((e) => e.value)).toEqual(['<ul><li>Two</li></ul>']);
      vi.advanceTimersByTime(PASTE_FALLBACK_MS);
      expect(page.executed).toHaveLength(1);
    });

    it('settles a paste still in flight as text before taking the next one', () => {
      const page = boot();
      page.paste({ 'text/plain': '- One' });
      page.paste({ 'text/plain': '- Two' });
      expect(page.executed.map((e) => [e.command, e.value])).toEqual([['insertText', '- One']]);
    });
  });
});
