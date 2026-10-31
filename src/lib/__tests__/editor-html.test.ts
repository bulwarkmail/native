import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildEditorCsp, buildEditorHtml, CHANGE_THROTTLE_MS, isEditorNavigationAllowed, shouldBlockEditorRemoteImages,
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
    // (The embedded content writes `<` as an escape, so it is left out here.)
    const script = extractScript(buildEditorHtml({ ...base, initialHtml: 'x' }));
    expect(script).not.toContain('\\');
  });

  it('embeds initial content as a JSON string and the placeholder as an attribute', () => {
    const html = buildEditorHtml({
      ...base,
      initialHtml: '<p>He said "hi" & left</p>',
      placeholder: 'Say "something"…',
    });
    expect(html).toContain(JSON.stringify('<p>He said "hi" & left</p>').replace(/</g, '\\u003c'));
    expect(html).toContain('data-placeholder="Say &quot;something&quot;…"');
  });

  // A quoted original's kept <style> carried `</script/>`: the page script
  // ended there, the rest of the reply ran as markup and a refresh meta took
  // the editor to a data:text/html page.
  it('keeps a quoted </script inside the page script', () => {
    const quoted = '<p>hello</p><style>p{}</script/><img src=x onerror=alert(1)><meta http-equiv=refresh content=0;url=data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg== x=';
    const initialHtml = `<p><br></p><div data-quoted-html>On X wrote:<blockquote>${quoted}</blockquote></div>\u2028`;
    const html = buildEditorHtml({ ...base, initialHtml });
    // The only end tag is the script's own.
    expect(html.match(/<\/script/gi)).toHaveLength(1);
    const script = extractScript(html);
    expect(() => new Function(script)).not.toThrow();
    const embedded = script.match(/var initial = (.*);/)![1];
    expect(JSON.parse(embedded)).toBe(initialHtml);
    expect(embedded).not.toContain('\u2028');
  });

  it('lets the editor load nothing but its own about:blank page', () => {
    expect(isEditorNavigationAllowed('about:blank')).toBe(true);
    expect(isEditorNavigationAllowed(undefined)).toBe(true);
    expect(isEditorNavigationAllowed('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==')).toBe(false);
    expect(isEditorNavigationAllowed('about:srcdoc')).toBe(false);
    expect(isEditorNavigationAllowed('https://example.com/')).toBe(false);
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

describe('collapsed reply quote (webmail #1405)', () => {
  type Listener = (e?: { preventDefault: () => void }) => void;
  function boot(opts: { collapseQuote?: boolean; withQuote?: boolean } = {}) {
    const docListeners: Record<string, Listener[]> = {};
    const classes = new Set<string>();
    const appended: unknown[] = [];
    const created: string[] = [];
    let anchorNode: unknown = null;
    const editor: Record<string, unknown> = {
      innerHTML: '',
      get textContent() { return 'x'; },
      scrollHeight: 400,
      classList: {
        add: (n: string) => classes.add(n),
        remove: (n: string) => classes.delete(n),
        contains: (n: string) => classes.has(n),
      },
      querySelector: () => null,
      setAttribute: () => undefined,
      focus: () => undefined,
      addEventListener: () => undefined,
    };
    const quoteChild = { parentNode: null as unknown };
    const quote = {
      hasAttribute: (n: string) => n === 'data-quoted-html',
      nextElementSibling: null,
      offsetTop: 120,
      offsetLeft: 16,
      parentNode: editor,
    };
    quoteChild.parentNode = quote;
    const typed = { hasAttribute: () => false, nextElementSibling: opts.withQuote === false ? null : quote, parentNode: editor };
    Object.defineProperty(editor, 'firstElementChild', { get: () => typed });
    const button = {
      style: {} as Record<string, string>,
      attrs: {} as Record<string, string>,
      listeners: {} as Record<string, Listener[]>,
      title: '',
      setAttribute(n: string, v: string) { this.attrs[n] = v; },
      addEventListener(n: string, fn: Listener) { (this.listeners[n] ??= []).push(fn); },
    };
    const document = {
      activeElement: editor as unknown,
      body: { appendChild: (n: unknown) => appended.push(n) },
      getElementById: () => editor,
      createElement: (tag: string) => { created.push(tag); return button; },
      addEventListener: (name: string, fn: Listener) => { (docListeners[name] ??= []).push(fn); },
      queryCommandState: () => false,
    };
    const window = {
      ReactNativeWebView: { postMessage: () => undefined },
      addEventListener: () => undefined,
      getSelection: () => ({ rangeCount: 1, anchorNode }),
    };
    const script = extractScript(buildEditorHtml({
      initialHtml: '<p><br></p><div data-quoted-html="true">q</div>',
      placeholder: '',
      c: LIGHT_COLORS,
      collapseQuote: opts.collapseQuote ?? true,
      quoteToggleLabels: { show: 'Zitat zeigen', hide: 'Zitat verbergen' },
    }));
    new Function('window', 'document', script)(window, document);
    const click = () => (button.listeners.click ?? []).forEach((fn) => fn({ preventDefault: () => undefined }));
    const caretAt = (node: unknown) => { anchorNode = node; (docListeners.selectionchange ?? []).forEach((fn) => fn()); };
    return { classes, appended, created, button, click, caretAt, quoteChild, typed };
  }

  it('starts a reply with the quote folded behind a toggle outside the editable text', () => {
    const page = boot();
    expect(page.classes.has('rne-quote-collapsed')).toBe(true);
    // On the page body, never inside the editor: it is no part of the message.
    expect(page.appended).toEqual([page.button]);
    expect(page.button.attrs['aria-expanded']).toBe('false');
    expect(page.button.attrs['aria-label']).toBe('Zitat zeigen');
    expect(page.button.style.top).toBe('124px');
    expect(page.button.style.display).toBe('block');
  });

  it('shows and hides the quote on a tap', () => {
    const page = boot();
    page.click();
    expect(page.classes.has('rne-quote-collapsed')).toBe(false);
    expect(page.button.attrs['aria-label']).toBe('Zitat verbergen');
    page.click();
    expect(page.classes.has('rne-quote-collapsed')).toBe(true);
  });

  it('shows the quote when the caret moves into it', () => {
    const page = boot();
    page.caretAt(page.typed);
    expect(page.classes.has('rne-quote-collapsed')).toBe(true);
    page.caretAt(page.quoteChild);
    expect(page.classes.has('rne-quote-collapsed')).toBe(false);
  });

  it('adds nothing to a message without a quote, or when not asked', () => {
    expect(boot({ withQuote: false }).created).toEqual([]);
    expect(boot({ collapseQuote: false }).created).toEqual([]);
  });

  it('hides the quote with styles on the editor element, so it stays in the sent body', () => {
    const html = buildEditorHtml({ initialHtml: 'x', placeholder: '', c: LIGHT_COLORS, collapseQuote: true });
    expect(html).toMatch(/#editor\.rne-quote-collapsed > \[data-quoted-html\] \{ height: 30px; overflow: hidden; \}/);
    const script = extractScript(html);
    expect(() => new Function(script)).not.toThrow();
    expect(script).not.toContain('\\');
  });

  it('is asked for on a reply in the composer', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../screens/ComposeScreen.tsx'), 'utf8');
    expect(source).toMatch(/const collapseReplyQuote = isReplyLike && \(mode === 'reply' \|\| mode === 'replyAll'\);/);
    expect(source).toMatch(/collapseQuote=\{collapseReplyQuote && editorSeedHtml === initialBodyHtml\}/);
  });
});

describe('image descriptions (webmail 53cb49d3c)', () => {
  function boot() {
    const inserted: string[] = [];
    const images = [
      { attrs: { 'data-cid': 'a@x' } as Record<string, string> },
      { attrs: { 'data-cid': 'b@x' } as Record<string, string> },
    ].map((img) => ({
      ...img,
      getAttribute(n: string) { return this.attrs[n] ?? null; },
      setAttribute(n: string, v: string) { this.attrs[n] = v; },
    }));
    const editor = {
      innerHTML: '',
      get textContent() { return 'x'; },
      scrollHeight: 100,
      querySelector: () => null,
      setAttribute: () => undefined,
      focus: () => undefined,
      addEventListener: () => undefined,
      getElementsByTagName: () => images,
    };
    const document = {
      activeElement: editor as unknown,
      getElementById: () => editor,
      addEventListener: () => undefined,
      queryCommandState: () => false,
      execCommand: (_cmd: string, _ui: boolean, html: string) => { inserted.push(html); return true; },
    };
    const window: Record<string, unknown> = {
      ReactNativeWebView: { postMessage: () => undefined },
      addEventListener: () => undefined,
      getSelection: () => null,
    };
    const script = extractScript(buildEditorHtml({ initialHtml: '<p><br></p>', placeholder: '', c: LIGHT_COLORS }));
    new Function('window', 'document', script)(window, document);
    return { rne: window.__rne as Record<string, (...args: unknown[]) => void>, inserted, images };
  }

  it('inserts an image without alt text until it is described, never with the file name', () => {
    const page = boot();
    page.rne.insertImage('data:image/png;base64,AA', 'a@x', null);
    expect(page.inserted[0]).toBe('<img src="data:image/png;base64,AA" data-cid="a@x" />');
    page.rne.insertImage('data:image/png;base64,AA', 'b@x', 'A "red" bike');
    expect(page.inserted[1]).toBe('<img src="data:image/png;base64,AA" alt="A &quot;red&quot; bike" data-cid="b@x" />');
  });

  it('describes the inline image with that cid, or marks it decorative', () => {
    const page = boot();
    page.rne.setImageAlt('b@x', 'a red bike');
    expect(page.images.map((i) => i.attrs.alt)).toEqual([undefined, 'a red bike']);
    page.rne.setImageAlt('a@x', '');
    expect(page.images[0].attrs.alt).toBe('');
  });

  it('asks for a description when the composer inserts an image, and writes it into the text part', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../screens/ComposeScreen.tsx'), 'utf8');
    expect(source).toMatch(/editorRef\.current\?\.insertImage\(dataUrl, cid, null\);\s+setAltQueue\(\(q\) => \[\.\.\.q, \{ cid, src: dataUrl \}\]\);/);
    expect(source).toMatch(/editorRef\.current\?\.setImageAlt\(altTarget\.cid, alt\);/);
    expect(source).toMatch(/imageAlt: \(alt\) => t\('email_composer\.image_alt\.plain_text', '\[Image: \{alt\}\]', \{ alt \}\)/);
  });
});
