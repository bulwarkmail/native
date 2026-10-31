import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Reply opened with no keyboard on Android and focus on the composer's
// Close button (a hardware Space shut the composer). 8bb7b607 focused the
// editor inside its page only; an Android WebView takes the keyboard and
// key focus only with native view focus, which nothing gave it. The suite
// has no React Native renderer, so this checks the editor's wiring.

const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'components/RichTextEditor.tsx'), 'utf8');

describe('rich text editor focus', () => {
  it('gives the WebView native focus before focusing the editor in the page', () => {
    const handle = src.slice(src.indexOf('focusEnd: () =>'), src.indexOf('blur: () =>'));
    expect(handle).toMatch(/focusEnd: \(\) => \{\s+requestNativeFocus\(\);\s+call\(`window\.__rne && window\.__rne\.focusEnd\(\)`\);/);
    expect(handle).toMatch(/focus: \(\) => \{\s+requestNativeFocus\(\);\s+call\(`window\.__rne && window\.__rne\.focus\(\)`\);/);
  });

  it('asks for native focus on Android, and holds the request until the page is up', () => {
    const fn = src.slice(src.indexOf('const requestNativeFocus'), src.indexOf('const call = '));
    expect(fn).toMatch(/if \(Platform\.OS !== 'android'\) return;/);
    expect(fn).toMatch(/if \(!readyRef\.current\) \{\s+wantsNativeFocusRef\.current = true;\s+return;\s+\}\s+webViewRef\.current\?\.requestFocus\(\);/);
    const ready = src.slice(src.indexOf('if (!readyRef.current) {\r\n      readyRef.current = true;'.replace(/\r\n/g, src.includes('\r\n') ? '\r\n' : '\n')));
    expect(ready).toMatch(/if \(wantsNativeFocusRef\.current\) \{\s+wantsNativeFocusRef\.current = false;\s+webViewRef\.current\?\.requestFocus\(\);\s+\}\s+for \(const script of queued\)/);
  });
});
