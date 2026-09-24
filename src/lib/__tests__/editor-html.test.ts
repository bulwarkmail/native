import { describe, expect, it } from 'vitest';
import { buildEditorCsp, buildEditorHtml, shouldBlockEditorRemoteImages } from '../editor-html';
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
