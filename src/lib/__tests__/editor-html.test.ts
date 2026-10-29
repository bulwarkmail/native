import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildEditorCsp, buildEditorHtml, CHANGE_THROTTLE_MS, shouldBlockEditorRemoteImages,
} from '../editor-html';
import { LIGHT_COLORS, DARK_COLORS } from '../../theme/tokens';

function extractScript(html: string): string {
  const m = html.match(/<script(?: nonce="[0-9a-f]+")?>([\s\S]*?)<\/script>/);
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
  });

  // An `<img onerror>` in a quoted original or a paste must not run: only the
  // page's own script, which carries a fresh nonce, may.
  it('runs only its own script, never inline handlers', () => {
    const html = buildEditorHtml(base);
    const csp = cspOf(html);
    const nonce = csp.match(/script-src 'nonce-([0-9a-f]{32})'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(cspOf(buildEditorHtml(base))).not.toBe(csp);
  });

  it('blocks remote images and fonts but keeps data: and blob: images', () => {
    const csp = cspOf(buildEditorHtml({ ...base, blockRemoteImages: true }));
    expect(csp).toContain('img-src data: blob:;');
    expect(csp).not.toMatch(/https?:/);
    expect(csp).toContain('font-src data:;');
  });

  it('allows remote images when not blocking', () => {
    expect(buildEditorCsp(false)).toContain('img-src data: blob: https: http:');
    const csp = cspOf(buildEditorHtml(base));
    const nonce = csp.match(/'nonce-([0-9a-f]+)'/)![1];
    expect(csp).toBe(buildEditorCsp(false, nonce));
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
  function boot() {
    const listeners: Record<string, Array<() => void>> = {};
    const docListeners: Record<string, Array<() => void>> = {};
    const posted: Array<{ type: string; payload: unknown }> = [];
    const editor = {
      innerHTML: '',
      get textContent() { return this.innerHTML.replace(/<[^>]*>/g, ''); },
      scrollHeight: 100,
      querySelector: () => null,
      setAttribute: () => undefined,
      focus: () => undefined,
      addEventListener: (name: string, fn: () => void) => { (listeners[name] ??= []).push(fn); },
    };
    const commandState: Record<string, boolean> = {};
    const document = {
      activeElement: editor as unknown,
      getElementById: () => editor,
      addEventListener: (name: string, fn: () => void) => { (docListeners[name] ??= []).push(fn); },
      queryCommandState: (name: string) => !!commandState[name],
    };
    const window = {
      ReactNativeWebView: { postMessage: (msg: string) => posted.push(JSON.parse(msg)) },
      addEventListener: () => undefined,
      getSelection: () => null,
    };
    const script = extractScript(buildEditorHtml({ initialHtml: '<p><br></p>', placeholder: '', c: LIGHT_COLORS }));
    new Function('window', 'document', script)(window, document);
    const changes = () => posted.filter((m) => m.type === 'change').map((m) => m.payload);
    const selections = () => posted.filter((m) => m.type === 'selection');
    const type = (html: string) => { editor.innerHTML = html; listeners.input.forEach((fn) => fn()); };
    const fire = (name: string) => (listeners[name] ?? docListeners[name]).forEach((fn) => fn());
    return { changes, selections, type, fire, commandState, posted };
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
});

// Android pans the editor page's visual viewport to reveal the caret and the
// pan outlived the moment: back at the top of the composer the body's first
// lines stayed hidden under To/Cc/Subject. The page undoes each pan and hands
// the offset to RN instead.
describe('editor visual viewport pinning', () => {
  function boot(pinVisualViewport: boolean | undefined, withVisualViewport = true) {
    const posted: Array<{ type: string; payload: unknown }> = [];
    const scrolledIntoView: unknown[] = [];
    const vvListeners: Record<string, Array<() => void>> = {};
    const visualViewport = {
      offsetTop: 0,
      addEventListener: (name: string, fn: () => void) => { (vvListeners[name] ??= []).push(fn); },
    };
    const editor = {
      innerHTML: '',
      get textContent() { return this.innerHTML.replace(/<[^>]*>/g, ''); },
      scrollHeight: 100,
      querySelector: () => null,
      setAttribute: () => undefined,
      focus: () => undefined,
      addEventListener: () => undefined,
      // Resetting the pan is what scrolling the page top into view does.
      scrollIntoView: (opts: unknown) => { scrolledIntoView.push(opts); visualViewport.offsetTop = 0; },
    };
    const document = {
      activeElement: editor as unknown,
      getElementById: () => editor,
      addEventListener: () => undefined,
      queryCommandState: () => false,
    };
    const window = {
      ReactNativeWebView: { postMessage: (msg: string) => posted.push(JSON.parse(msg)) },
      addEventListener: () => undefined,
      getSelection: () => null,
      visualViewport: withVisualViewport ? visualViewport : undefined,
    };
    const script = extractScript(buildEditorHtml({
      initialHtml: '<p><br></p>', placeholder: '', c: LIGHT_COLORS, pinVisualViewport,
    }));
    new Function('window', 'document', script)(window, document);
    const pan = (offsetTop: number) => {
      visualViewport.offsetTop = offsetTop;
      (vvListeners.scroll ?? []).forEach((fn) => fn());
    };
    const shifts = () => posted.filter((m) => m.type === 'viewportShift').map((m) => m.payload);
    return { pan, shifts, scrolledIntoView, visualViewport, vvListeners };
  }

  it('undoes a caret-reveal pan and reports its offset to RN', () => {
    const page = boot(true);
    page.pan(18.5);
    expect(page.visualViewport.offsetTop).toBe(0);
    expect(page.scrolledIntoView).toEqual([{ block: 'start', inline: 'nearest' }]);
    expect(page.shifts()).toEqual([18.5]);
  });

  it('ignores the scroll event its own reset fires', () => {
    const page = boot(true);
    page.pan(40);
    page.pan(0);
    page.pan(0.2);
    expect(page.shifts()).toEqual([40]);
    expect(page.scrolledIntoView).toHaveLength(1);
  });

  it('reports each later pan separately', () => {
    const page = boot(true);
    page.pan(12);
    page.pan(30);
    expect(page.shifts()).toEqual([12, 30]);
  });

  it('leaves the viewport alone unless asked (iOS, settings editors)', () => {
    const off = boot(false);
    expect(off.vvListeners.scroll).toBeUndefined();
    const unset = boot(undefined);
    expect(unset.vvListeners.scroll).toBeUndefined();
  });

  it('survives a WebView without visualViewport', () => {
    expect(() => boot(true, false)).not.toThrow();
  });
});
