// The reading font for the app's own text (Settings > Accessibility > Font).
//
// The webmail sets one CSS variable on <html> and every piece of text follows
// (app/accessibility.css data-app-font). React Native has no inherited font:
// each Text takes its family from its own style, the app's styles name none,
// and Text.defaultProps is gone on the new architecture. So the app's Text
// and TextInput components are wrapped once at startup: the wrapper puts the
// chosen family under the caller's own style (an explicit fontFamily still
// wins) and re-renders when the setting changes.
//
// Wrapping happens before any screen module loads (index.ts imports
// ./reading-font-install first): with Metro's import support every module
// copies `Text` out of react-native when it is evaluated, so a module loaded
// earlier keeps the plain component. The wrapper stays installed for the
// whole run, also while the theme font is chosen; swapping the component
// later would remount every text field.

import { useSyncExternalStore } from 'react';

type Props = { style?: unknown } & Record<string, unknown>;
type FunctionComponent = ((props: Props) => unknown) & { displayName?: string };

let family: string | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** The family the app's text is drawn in right now, or null for the theme font. */
export function getUiFontFamily(): string | null {
  return family;
}

/** Changes the family; every wrapped Text re-renders. */
export function setUiFontFamily(next: string | null): void {
  if (next === family) return;
  family = next;
  for (const listener of [...listeners]) listener();
}

/** `props` with the family under the caller's own style; unchanged for null. */
export function withFontFamily<P extends { style?: unknown }>(props: P, fontFamily: string | null): P {
  if (!fontFamily) return props;
  return { ...props, style: props.style == null ? { fontFamily } : [{ fontFamily }, props.style] };
}

const WRAPPED = Symbol.for('bulwark.readingFont');

/**
 * A component that renders `Original` with the reading font. `Original` is
 * called as a function, not rendered as a child, so no extra component is
 * added per text: its hooks run as part of the wrapper, always in the same
 * order. Statics (TextInput.State) and the display name are kept.
 */
export function wrapWithReadingFont(Original: FunctionComponent): FunctionComponent {
  const Wrapped = function ReadingFontText(props: Props) {
    const current = useSyncExternalStore(subscribe, getUiFontFamily, getUiFontFamily);
    return Original(withFontFamily(props, current));
  } as FunctionComponent;
  Object.assign(Wrapped, Original);
  Wrapped.displayName = Original.displayName ?? Original.name;
  (Wrapped as unknown as Record<symbol, unknown>)[WRAPPED] = true;
  return Wrapped;
}

/**
 * Wraps the default export of each module (react-native's Text and
 * TextInput) in place. Only plain function components are wrapped; anything
 * else (a future memo or forwardRef object) is left alone. Returns how many
 * were wrapped; a second call wraps nothing.
 */
export function wrapModuleDefaults(modules: Array<{ default?: unknown }>): number {
  let wrapped = 0;
  for (const mod of modules) {
    const component = mod?.default;
    if (typeof component !== 'function') continue;
    if ((component as unknown as Record<symbol, unknown>)[WRAPPED]) continue;
    try {
      mod.default = wrapWithReadingFont(component as FunctionComponent);
      wrapped++;
    } catch {
      // A read-only export: leave the component as it is.
    }
  }
  return wrapped;
}
