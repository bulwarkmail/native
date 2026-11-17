import React from 'react';
import { NativeEventEmitter, NativeModules, Platform, useWindowDimensions } from 'react-native';

/**
 * The hinge of a foldable iPhone (the iPhone Duo), from UIKit's
 * UIHingeInteraction (plugins/ios-desk). Null on any other device, on
 * Android, and on an app built with an SDK older than iOS 27.1.
 */
export interface HingeState {
  /** UIHinge.Status: closed 1, partially open 2, fully open 3 (read on the Duo); 0 unknown. */
  status: number;
  /** Degrees: 0 shut, 180 open flat. */
  angle: number;
}

export const HINGE_CLOSED = 1;
export const HINGE_PARTIALLY_OPEN = 2;

/**
 * A closed Duo counts as standing as a tent from TENT_MIN_ANGLE, and stops
 * below TENT_EXIT_ANGLE, so a hinge held near the line does not switch the
 * desk inbox on and off. The hinge reads "closed" for any fold that keeps
 * the inner display dark, and reports the angle it is held at (a tent stands
 * at about 60 to 90 degrees).
 */
export const TENT_MIN_ANGLE = 20;
export const TENT_EXIT_ANGLE = 12;

/**
 * Whether a Duo stands on a desk as a tent: folded part way with the inner
 * display hidden inside, the app running sideways on the outer display.
 * iOS reports that as a closed hinge with an angle, in a landscape window.
 * `wasTent`: it stood as a tent until now, which lowers the angle needed.
 */
export function isTent(hinge: HingeState | null, width: number, height: number, wasTent = false): boolean {
  const min = wasTent ? TENT_EXIT_ANGLE : TENT_MIN_ANGLE;
  return !!hinge && hinge.status === HINGE_CLOSED && hinge.angle >= min && width > height;
}

type Native = { current(): Promise<unknown> };

function toState(value: unknown): HingeState | null {
  const v = value as { status?: unknown; angle?: unknown } | null;
  return v && typeof v.status === 'number' && typeof v.angle === 'number' ? { status: v.status, angle: v.angle } : null;
}

// One native subscription for every hook: while the hinge moves it sends a
// stream of angles.
let latest: HingeState | null = null;
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const native = NativeModules.BulwarkHinge as Native | undefined;
  if (!unsubscribe && Platform.OS === 'ios' && native) {
    const set = (e: unknown) => {
      latest = toState(e);
      for (const l of listeners) l();
    };
    const sub = new NativeEventEmitter(NativeModules.BulwarkHinge).addListener('hinge', set);
    void native.current().then(set).catch(() => {});
    unsubscribe = () => sub.remove();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };
}

/**
 * A value derived from the hinge (a number, string or boolean), re-rendering
 * only when it changes: a screen that needs "half open" is not re-rendered
 * for every degree.
 */
export function useHingeValue<T extends string | number | boolean | null>(select: (hinge: HingeState | null) => T): T {
  const selectRef = React.useRef(select);
  selectRef.current = select;
  const [value, setValue] = React.useState(() => select(latest));
  React.useEffect(() => {
    const update = () => setValue(selectRef.current(latest));
    update();
    return subscribe(update);
  }, []);
  return value;
}

/** How a closed hinge stands, coarse enough to change rarely. */
function tentBand(h: HingeState | null): 'tent' | 'edge' | 'none' {
  if (!h || h.status !== HINGE_CLOSED) return 'none';
  return h.angle >= TENT_MIN_ANGLE ? 'tent' : h.angle >= TENT_EXIT_ANGLE ? 'edge' : 'none';
}

/** Whether the Duo stands as a tent now (`isTent`, with its hysteresis). */
export function useTent(): boolean {
  const { width, height } = useWindowDimensions();
  const band = useHingeValue(tentBand);
  const wasTent = React.useRef(false);
  const tent = width > height && (band === 'tent' || (band === 'edge' && wasTent.current));
  wasTent.current = tent;
  return tent;
}

/** Whether the hinge is partially open (the Duo held like a book or a laptop). */
export function useHalfOpen(): boolean {
  return useHingeValue((h) => h?.status === HINGE_PARTIALLY_OPEN);
}
