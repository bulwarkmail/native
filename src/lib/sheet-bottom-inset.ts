import React from 'react';
import { Dimensions, Keyboard, Platform, type KeyboardMetrics } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { keyboardObstruction } from './use-keyboard-obstruction';

/**
 * Bottom padding for a sheet whose surface reaches the screen bottom: clear
 * of the navigation bar, and of the keyboard while it is open (the keyboard's
 * overlap is measured from the screen bottom, so it already covers the bar).
 */
export function sheetBottomInset(safeBottom: number, keyboard: number): number {
  return Math.max(0, safeBottom, keyboard);
}

/**
 * Extra bottom padding for a full-screen modal whose SafeAreaView already
 * keeps `safeBottom` clear: the part of the keyboard above that. Android only;
 * on iOS those modals use a KeyboardAvoidingView.
 */
export function modalKeyboardPadding(keyboard: number, safeBottom: number, os: string): number {
  if (os !== 'android') return 0;
  return Math.max(0, Math.round(keyboard - safeBottom));
}

/**
 * How much of the screen bottom the keyboard covers while `enabled`. A Modal
 * on Android is an edge-to-edge window the keyboard does not resize, and an
 * iOS Modal never resizes, so a sheet has to make room itself. Tracked only
 * while the sheet is open, so a hidden sheet doesn't re-render on every
 * keyboard change. A rotation leaves a stale frame (Android sends no new
 * keyboard event), so it closes the keyboard like use-keyboard-obstruction.
 */
function useKeyboardOverlap(enabled: boolean, safeBottom: number): number {
  const [overlap, setOverlap] = React.useState(0);
  const insetRef = React.useRef(safeBottom);
  insetRef.current = safeBottom;
  React.useEffect(() => {
    if (!enabled) {
      setOverlap(0);
      return undefined;
    }
    const apply = (frame: Pick<KeyboardMetrics, 'screenY' | 'height'> | undefined | null) => {
      if (!frame) {
        setOverlap(0);
        return;
      }
      setOverlap(keyboardObstruction(Dimensions.get('screen').height, frame.screenY, frame.height, insetRef.current));
    };
    // The keyboard may already be up when the sheet opens.
    if (Keyboard.isVisible()) apply(Keyboard.metrics());
    const subs =
      Platform.OS === 'ios'
        ? [
            Keyboard.addListener('keyboardWillChangeFrame', (e) => apply(e.endCoordinates)),
            Keyboard.addListener('keyboardWillHide', () => setOverlap(0)),
          ]
        : [
            Keyboard.addListener('keyboardDidShow', (e) => apply(e.endCoordinates)),
            Keyboard.addListener('keyboardDidHide', () => setOverlap(0)),
          ];
    let lastWindow = Dimensions.get('window');
    const dims = Dimensions.addEventListener('change', ({ window }) => {
      if (window.width === lastWindow.width && window.height === lastWindow.height) return;
      lastWindow = window;
      setOverlap(0);
      if (Keyboard.isVisible()) Keyboard.dismiss();
    });
    return () => {
      for (const s of subs) s.remove();
      dims.remove();
    };
  }, [enabled]);
  return enabled ? overlap : 0;
}

/**
 * How far the content of a bottom sheet or dialog has to stay above the
 * screen bottom.
 *
 * Every RN Modal on Android is edge to edge here: with edge-to-edge on (Expo
 * SDK 54) the Modal forces statusBarTranslucent and navigationBarTranslucent,
 * so its window reaches under the navigation bar, a phone's gesture bar or a
 * tablet's taskbar. A sheet that ends at `bottom: 0` (or a backdrop that
 * aligns it with `justifyContent: 'flex-end'`) puts its last row under that
 * bar, where a tap goes to the taskbar instead (an app icon opened). The sheet
 * keeps its surface down to the screen edge and pads its content by this.
 * The same window doesn't shrink for the keyboard, so while the keyboard is
 * open this is its overlap instead: a sheet's text field and its Save button
 * stay above it, and a centred dialog padded by it moves up.
 *
 * Inside a plain Modal the insets come from the app's provider (React context
 * reaches into the Modal); inside a SafeAreaModal from the Modal's own.
 * `enabled` is the sheet's visibility, for sheets that stay mounted.
 */
export function useSheetBottomInset(enabled = true): number {
  const safeBottom = useSafeAreaInsets().bottom;
  const keyboard = useKeyboardOverlap(enabled, safeBottom);
  return sheetBottomInset(safeBottom, keyboard);
}

/**
 * `modalKeyboardPadding` for a full-screen modal (a SafeAreaView with the
 * bottom edge inside a SafeAreaModal): pad the scrolling body by this so the
 * focused field and the last row stay above the keyboard on Android.
 */
export function useModalKeyboardPadding(enabled = true): number {
  const safeBottom = useSafeAreaInsets().bottom;
  const keyboard = useKeyboardOverlap(enabled, safeBottom);
  return modalKeyboardPadding(keyboard, safeBottom, Platform.OS);
}
