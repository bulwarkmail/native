// Whether TalkBack or VoiceOver is on, readable without a hook (the toast
// store decides a toast's duration when it is queued). Starts watching on
// first use; until the first answer arrives it reads as off.

import { AccessibilityInfo } from 'react-native';

let screenReaderOn = false;
let watching = false;

function watch(): void {
  if (watching) return;
  watching = true;
  const info = AccessibilityInfo as typeof AccessibilityInfo | undefined;
  try {
    void info?.isScreenReaderEnabled?.().then((on) => { screenReaderOn = on; }).catch(() => undefined);
    info?.addEventListener?.('screenReaderChanged', (on: boolean) => { screenReaderOn = on; });
  } catch {
    // No accessibility bridge (tests, a headless task): stays off.
  }
}

export function isScreenReaderOn(): boolean {
  watch();
  return screenReaderOn;
}

/** Test hook. */
export function setScreenReaderOnForTests(on: boolean): void {
  watching = true;
  screenReaderOn = on;
}
