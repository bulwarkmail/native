import { NativeModules } from 'react-native';

// Whether this run of the app has seen a mouse pointer, and the call that
// makes the view under a still pointer the hovered one (MainActivity.rehover
// on Android; nothing elsewhere). Lists do their hover upkeep only once a
// mouse has been seen.

let seen = false;
const listeners = new Set<() => void>();

export function mouseSeen(): boolean {
  return seen;
}

export function subscribeMouseSeen(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** A mouse pointer has entered something. */
export function noteMouse(): void {
  if (seen) return;
  seen = true;
  listeners.forEach((listener) => listener());
}

/** The views under a still pointer have moved: hover the one that is under it now. */
export function rehover(): void {
  NativeModules.BulwarkPointer?.rehover?.();
}
