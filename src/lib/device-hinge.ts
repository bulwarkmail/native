import React from 'react';
import { NativeEventEmitter, NativeModules, Platform, useWindowDimensions } from 'react-native';

/**
 * The hinge of a foldable iPhone (the iPhone Duo), from UIKit's
 * UIHingeInteraction (plugins/ios-hinge). Null on any other device, on
 * Android, and on an app built with an SDK older than iOS 27.1.
 */
export interface HingeState {
  /** UIHinge.Status: unknown 0, closed 1, partially open 2, fully open 3. */
  status: number;
  /** Degrees: 0 shut, 180 open flat. */
  angle: number;
}

export const HINGE_CLOSED = 1;

/**
 * Below this a closed Duo is lying shut or in a hand, not standing: the
 * hinge reads "closed" for any fold that keeps the inner display dark, and
 * reports the angle it is held at (a tent stands at about 60 to 90 degrees).
 */
export const TENT_MIN_ANGLE = 20;

/**
 * Whether a Duo stands on a desk as a tent: folded part way with the inner
 * display hidden inside, the app running sideways on the outer display.
 * iOS reports that as a closed hinge with an angle, in a landscape window.
 */
export function isTent(hinge: HingeState | null, width: number, height: number): boolean {
  return !!hinge && hinge.status === HINGE_CLOSED && hinge.angle >= TENT_MIN_ANGLE && width > height;
}

type Native = { current(): Promise<HingeState | { status: null } | null> };

function toState(value: unknown): HingeState | null {
  const v = value as { status?: unknown; angle?: unknown } | null;
  return v && typeof v.status === 'number' && typeof v.angle === 'number' ? { status: v.status, angle: v.angle } : null;
}

/** The hinge as it changes; null where there is none. */
export function useHinge(): HingeState | null {
  const [hinge, setHinge] = React.useState<HingeState | null>(null);
  React.useEffect(() => {
    const native = NativeModules.BulwarkHinge as Native | undefined;
    if (Platform.OS !== 'ios' || !native) return;
    const sub = new NativeEventEmitter(NativeModules.BulwarkHinge).addListener('hinge', (e) => setHinge(toState(e)));
    void native.current().then((e) => setHinge(toState(e))).catch(() => {});
    return () => sub.remove();
  }, []);
  return hinge;
}

/** Whether the Duo stands as a tent now (`isTent`). */
export function useTent(): boolean {
  const hinge = useHinge();
  const { width, height } = useWindowDimensions();
  return isTent(hinge, width, height);
}
