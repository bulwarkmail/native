// How long toasts and the Undo bar stay (webmail lib/toast-duration.ts,
// 8d2ebccf0, WCAG 2.2.1). One setting, Settings > Accessibility >
// Notification duration, covers toasts with an action, errors and the Undo
// bar: 5 to 60 seconds, or until closed. Plain notices keep their own short
// time. The app's default is automatic: 5 s, or 20 s while TalkBack or
// VoiceOver is on, since reaching an Undo button by swiping takes longer
// than tapping it.

import { useSettingsStore } from '../stores/settings-store';
import { isScreenReaderOn } from './screen-reader';

/** How long a toast stays when nothing else says so. */
export const DEFAULT_TOAST_MS = 5000;
/** Errors stay longer than other toasts. */
export const DEFAULT_ERROR_TOAST_MS = 10000;
/** The automatic duration while a screen reader is on, in seconds. */
export const SCREEN_READER_TOAST_SECONDS = 20;
/** The setting's values: -1 automatic, 0 until closed, else seconds. */
export const TOAST_DURATION_CHOICES = [-1, 5, 10, 20, 60, 0] as const;

/** The setting in seconds; 0 keeps toasts until they are closed. */
export function userToastSeconds(): number {
  let stored = -1;
  try {
    const value = useSettingsStore.getState().toastDuration;
    if (typeof value === 'number') stored = value;
  } catch {
    // A store that isn't there yet: automatic.
  }
  if (stored >= 0) return stored;
  return isScreenReaderOn() ? SCREEN_READER_TOAST_SECONDS : DEFAULT_TOAST_MS / 1000;
}

/**
 * How long something that must not be missed stays: a toast with an action,
 * an error, the Undo bar. Never shorter than `baseMs`, the time the caller
 * picked; 0 when it stays until it is closed.
 */
export function lastingToastDuration(baseMs: number): number {
  const seconds = userToastSeconds();
  if (seconds === 0 || baseMs <= 0) return 0;
  return Math.max(baseMs, seconds * 1000);
}

/** The duration a new toast gets. A plain notice keeps its own time. */
export function effectiveToastDuration(toast: {
  type: string;
  duration?: number;
  action?: unknown;
}): number {
  const base = toast.duration ?? (toast.type === 'error' ? DEFAULT_ERROR_TOAST_MS : DEFAULT_TOAST_MS);
  if (base <= 0) return base;
  const lasting = toast.type === 'error' || !!toast.action;
  return lasting ? lastingToastDuration(base) : base;
}
