import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { focusEditorWithKeyboard, KEYBOARD_HANDOFF_MS } from '../editor-keyboard-handoff';

// Reply opened with no keyboard on Android and focus on the composer's
// Close button (a hardware Space shut the composer). 8bb7b607 focused the
// editor inside its page only; 461e4da0 gave the WebView native focus too,
// which put the caret in the body but still left the keyboard down
// (`mInputShown=false` on API 32 and 34): nothing asked the input method to
// show. A hidden TextInput's focus does, and the keyboard then moves over to
// the WebView. The suite has no React Native renderer, so the order of steps
// is checked on the helper and the editor's wiring on its source.

const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'components/RichTextEditor.tsx'), 'utf8');

function recorder() {
  const steps: string[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  return {
    steps,
    timers,
    targets: {
      focusHandoffInput: () => steps.push('input'),
      focusWebView: () => steps.push('webview'),
      runInPage: (s: string) => steps.push(`page:${s}`),
      schedule: (fn: () => void, ms: number) => { timers.push({ fn, ms }); },
    },
  };
}

describe('rich text editor focus', () => {
  it('opens the keyboard through the hidden field on Android, then hands focus to the WebView', () => {
    const r = recorder();
    focusEditorWithKeyboard('android', 'focusEnd()', r.targets);
    expect(r.steps).toEqual(['input', 'page:focusEnd()']);
    expect(r.timers).toHaveLength(1);
    expect(r.timers[0].ms).toBe(KEYBOARD_HANDOFF_MS);
    r.timers[0].fn();
    expect(r.steps).toEqual(['input', 'page:focusEnd()', 'webview', 'page:focusEnd()']);
  });

  it('only focuses the editor in the page on iOS', () => {
    const r = recorder();
    focusEditorWithKeyboard('ios', 'focus()', r.targets);
    expect(r.steps).toEqual(['page:focus()']);
    expect(r.timers).toHaveLength(0);
  });

  it('is how the editor focuses, also for a focus asked before the page was up', () => {
    const handle = src.slice(src.indexOf('focusEnd: () =>'), src.indexOf('blur: () =>'));
    expect(handle).toMatch(/focusEnd: \(\) => \{\s+focusWithKeyboard\(`window\.__rne && window\.__rne\.focusEnd\(\)`\);/);
    expect(handle).toMatch(/focus: \(\) => \{\s+focusWithKeyboard\(`window\.__rne && window\.__rne\.focus\(\)`\);/);
    expect(src).toMatch(/if \(!readyRef\.current\) \{\s+pendingFocusRef\.current = script;\s+return;\s+\}\s+focusEditorWithKeyboard\(Platform\.OS, script,/);
    expect(src).toMatch(/if \(pendingFocus\) focusWithKeyboard\(pendingFocus\);/);
  });

  it('renders the hidden field on Android', () => {
    expect(src).toMatch(/<TextInput\s+ref=\{handoffInputRef\}/);
    expect(src).toMatch(/focusHandoffInput: \(\) => handoffInputRef\.current\?\.focus\(\)/);
  });
});
