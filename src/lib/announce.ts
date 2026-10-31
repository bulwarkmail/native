// Screen reader announcements (webmail lib/announce.ts, 36d13b76b,
// e2fc2c750): short status text read out without moving the focus.
//
// Android reads the live regions the toast card, the Undo bar and the
// offline banner carry (accessibilityLiveRegion). iOS has no live regions,
// so nothing of them was ever read out there; VoiceOver is told through
// AccessibilityInfo instead. Errors interrupt what VoiceOver is saying,
// everything else waits its turn. The same text again within a couple of
// seconds is not repeated (two screens' banners, a burst of the same toast).

import { AccessibilityInfo, Platform } from 'react-native';

const REPEAT_WINDOW_MS = 2000;
const lastSaid = new Map<string, number>();

export interface AnnounceOptions {
  /** Interrupts VoiceOver. For errors only. */
  assertive?: boolean;
}

export function announce(message: string, options: AnnounceOptions = {}): void {
  if (Platform.OS !== 'ios') return;
  const text = message.replace(/\s+/g, ' ').trim();
  if (!text) return;
  const now = Date.now();
  const last = lastSaid.get(text);
  if (last !== undefined && now - last < REPEAT_WINDOW_MS) return;
  lastSaid.set(text, now);
  if (lastSaid.size > 50) {
    for (const [key, at] of lastSaid) if (now - at >= REPEAT_WINDOW_MS) lastSaid.delete(key);
  }
  try {
    if (AccessibilityInfo.announceForAccessibilityWithOptions) {
      AccessibilityInfo.announceForAccessibilityWithOptions(text, { queue: !options.assertive });
    } else {
      AccessibilityInfo.announceForAccessibility(text);
    }
  } catch {
    // Never let an announcement break the action that caused it.
  }
}

/** Title and message of a toast as one sentence (webmail toastAnnouncement). */
export function toastAnnouncement(toast: { title: string; message?: string; actionLabel?: string }): string {
  const sentence = (a: string, b: string | undefined) => {
    const next = b?.trim();
    if (!next) return a;
    if (!a) return next;
    return /[.!?…:]$/.test(a) ? `${a} ${next}` : `${a}. ${next}`;
  };
  return sentence(sentence(toast.title.trim(), toast.message), toast.actionLabel);
}

// The offline banner sits on several screens at once; the drop is said once,
// when the connection goes, not by every banner that mounts while offline.
let lastOnline: boolean | null = null;

export function announceConnectivity(online: boolean, offlineMessage: string): void {
  const wasOnline = lastOnline;
  lastOnline = online;
  if (!online && wasOnline !== false) announce(offlineMessage, { assertive: true });
}

/** Test hook. */
export function resetAnnouncements(): void {
  lastSaid.clear();
  lastOnline = null;
}
