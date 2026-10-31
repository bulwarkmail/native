// Opening the soft keyboard for the composer's WebView editor on Android.
// Reply put the caret in the body but no keyboard came up (API 32 and 34,
// `mInputShown=false`): 461e4da0 gave the WebView native focus before the
// page focused the editor, but neither asks the input method to show. The
// WebView only does that for a tap, and react-native-webview's requestFocus
// is a plain View.requestFocus(). A React Native TextInput's focus does call
// InputMethodManager.showSoftInput, though. So the keyboard is opened by a
// hidden TextInput first; then the WebView takes native focus and the page
// focuses the editor, and the open keyboard moves over to it. iOS opens the
// keyboard for a focus from script (keyboardDisplayRequiresUserAction off).

/** Time for the input method to come up for the hidden field before focus moves on. */
export const KEYBOARD_HANDOFF_MS = 60;

export interface KeyboardHandoffTargets {
  /** Focus the hidden TextInput (opens the keyboard). */
  focusHandoffInput(): void;
  /** Give the WebView native focus. */
  focusWebView(): void;
  /** Run a script in the editor page. */
  runInPage(script: string): void;
  schedule(fn: () => void, ms: number): void;
}

/**
 * Focus the editor with `script` (focus or focusEnd) and open the keyboard
 * for it: on Android through the hidden field, elsewhere by the script alone.
 */
export function focusEditorWithKeyboard(platform: string, script: string, targets: KeyboardHandoffTargets): void {
  if (platform !== 'android') {
    targets.runInPage(script);
    return;
  }
  targets.focusHandoffInput();
  // The caret goes where it should at once; the native focus follows once
  // the keyboard is up, and the editor is focused again for it.
  targets.runInPage(script);
  targets.schedule(() => {
    targets.focusWebView();
    targets.runInPage(script);
  }, KEYBOARD_HANDOFF_MS);
}
