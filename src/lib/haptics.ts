import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

// Tactile feedback helpers. Every call is fire-and-forget and swallows
// errors: haptics are a nicety, never a dependency. Callers outside this
// area (SwipeableRow, destructive confirms) should use these rather than
// importing expo-haptics directly so the "off" switch stays in one place.

export type HapticKind = 'selection' | 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error';

let enabled = true;

/** Global kill switch (e.g. when the user disables animations). */
export function setHapticsEnabled(value: boolean): void {
  enabled = value;
}

const ANDROID: Record<HapticKind, Haptics.AndroidHaptics> = {
  selection: Haptics.AndroidHaptics.Clock_Tick,
  light: Haptics.AndroidHaptics.Keyboard_Tap,
  medium: Haptics.AndroidHaptics.Virtual_Key,
  heavy: Haptics.AndroidHaptics.Long_Press,
  success: Haptics.AndroidHaptics.Confirm,
  warning: Haptics.AndroidHaptics.Reject,
  error: Haptics.AndroidHaptics.Reject,
};

function vibratorHaptic(kind: HapticKind): Promise<void> {
  switch (kind) {
    case 'selection':
      return Haptics.selectionAsync();
    case 'medium':
      return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    case 'heavy':
      return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    case 'success':
      return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    case 'warning':
      return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    case 'error':
      return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    case 'light':
    default:
      return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }
}

export function haptic(kind: HapticKind = 'light'): void {
  if (!enabled || Platform.OS === 'web') return;
  try {
    const promise = Platform.OS === 'android'
      ? Haptics.performAndroidHapticsAsync(ANDROID[kind]).catch(() => vibratorHaptic(kind))
      : vibratorHaptic(kind);
    void promise.catch(() => undefined);
  } catch {
    // native module missing (e.g. web / tests)
  }
}
