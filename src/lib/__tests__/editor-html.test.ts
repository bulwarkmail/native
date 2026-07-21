import { describe, expect, it } from 'vitest';
import { buildEditorHtml } from '../editor-html';
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
});
