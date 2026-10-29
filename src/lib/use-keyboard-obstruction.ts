import React from 'react';
import { Dimensions, Keyboard, Platform, type KeyboardEvent } from 'react-native';

/**
 * How much of the screen bottom the keyboard covers, given the keyboard's top
 * edge (`screenY`) and its reported height. On Android edge-to-edge the
 * reported height leaves out the gesture bar, so the gap from the keyboard's
 * top to the screen bottom is the better measure; it is capped by the
 * keyboard height plus the bottom inset so a stale screen size (a rotation
 * that arrives before the keyboard's own event) can't produce an overlap
 * taller than the keyboard.
 */
export function keyboardObstruction(
  screenHeight: number,
  screenY: number | undefined,
  height: number | undefined,
  bottomInset: number,
): number {
  const fromTop = typeof screenY === 'number' ? screenHeight - screenY : NaN;
  const reported = typeof height === 'number' && height > 0 ? height : NaN;
  if (Number.isNaN(fromTop) && Number.isNaN(reported)) return 0;
  if (Number.isNaN(fromTop)) return Math.max(0, reported);
  if (Number.isNaN(reported)) return Math.max(0, fromTop);
  return Math.max(0, Math.min(fromTop, reported + bottomInset));
}

/**
 * Tracks the keyboard's overlap with the bottom of the screen.
 *
 * Android sends no keyboard event when the window rotates with the keyboard
 * open, so the last frame (from the other orientation) is all there is: a
 * portrait keyboard kept as the overlap blanked the whole landscape composer.
 * A window change with the keyboard open therefore closes the keyboard; the
 * text stays, and the next tap opens it with the right size. `onWindowChange`
 * lets a screen drop focus that `Keyboard.dismiss` can't reach (a WebView).
 */
export function useKeyboardObstruction(bottomInset: number, onWindowChange?: () => void): number {
  const [obstruction, setObstruction] = React.useState(0);
  const insetRef = React.useRef(bottomInset);
  insetRef.current = bottomInset;
  const onWindowChangeRef = React.useRef(onWindowChange);
  onWindowChangeRef.current = onWindowChange;
  React.useEffect(() => {
    const apply = (e?: Pick<KeyboardEvent, 'endCoordinates'> | null) => {
      if (!e?.endCoordinates) {
        setObstruction(0);
        return;
      }
      const { screenY, height } = e.endCoordinates;
      setObstruction(keyboardObstruction(Dimensions.get('screen').height, screenY, height, insetRef.current));
    };
    const subs =
      Platform.OS === 'ios'
        ? [
            Keyboard.addListener('keyboardWillChangeFrame', apply),
            Keyboard.addListener('keyboardWillHide', () => setObstruction(0)),
          ]
        : [
            Keyboard.addListener('keyboardDidShow', apply),
            Keyboard.addListener('keyboardDidHide', () => setObstruction(0)),
          ];
    let lastWindow = Dimensions.get('window');
    const dims = Dimensions.addEventListener('change', ({ window }) => {
      if (window.width === lastWindow.width && window.height === lastWindow.height) return;
      lastWindow = window;
      setObstruction(0);
      if (!Keyboard.isVisible()) return;
      Keyboard.dismiss();
      onWindowChangeRef.current?.();
    });
    return () => {
      for (const s of subs) s.remove();
      dims.remove();
    };
  }, []);
  return obstruction;
}
