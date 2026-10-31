// A small renderer for the card tests. The app has no React renderer in its
// test setup (no react-test-renderer, no testing-library), so this walks the
// element tree, calls each function component with a stand-in hook
// dispatcher, and returns the host elements (View, Text, Pressable ...) as
// plain objects. One pass, no commits: state setters and effects do nothing
// here, which is what a snapshot of a card needs. renderHook below keeps
// state and runs effects, for hooks.
import React from 'react';
import { vi } from 'vitest';

type Internals = { H: unknown };
const internals = (React as unknown as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: Internals })
  .__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

export interface HostNode {
  type: string;
  props: Record<string, any>;
  children: Array<HostNode | string>;
}

const MEMO = Symbol.for('react.memo');
const FORWARD_REF = Symbol.for('react.forward_ref');
const FRAGMENT = Symbol.for('react.fragment');

const oneShotDispatcher = {
  useState: (init: unknown) => [typeof init === 'function' ? (init as () => unknown)() : init, () => undefined],
  useReducer: (_r: unknown, init: unknown, fn?: (a: unknown) => unknown) => [fn ? fn(init) : init, () => undefined],
  useMemo: (fn: () => unknown) => fn(),
  useCallback: (fn: unknown) => fn,
  useRef: (current: unknown) => ({ current }),
  useEffect: () => undefined,
  useLayoutEffect: () => undefined,
  useInsertionEffect: () => undefined,
  useImperativeHandle: () => undefined,
  useContext: (context: { _currentValue: unknown }) => context._currentValue,
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useDebugValue: () => undefined,
  useId: () => ':r:',
  useTransition: () => [false, (fn: () => void) => fn()],
  useDeferredValue: (value: unknown) => value,
};

function renderNode(node: unknown, out: Array<HostNode | string>): void {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) renderNode(child, out);
    return;
  }
  const element = node as { type: any; props: Record<string, any> };
  const { type, props } = element;
  if (type === FRAGMENT) {
    renderNode(props.children, out);
    return;
  }
  if (typeof type === 'string') {
    const children: Array<HostNode | string> = [];
    renderNode(props.children, children);
    out.push({ type, props, children });
    return;
  }
  if (type && type.$$typeof === MEMO) {
    renderNode({ type: type.type, props }, out);
    return;
  }
  if (type && type.$$typeof === FORWARD_REF) {
    renderNode(callComponent(() => type.render(props, null)), out);
    return;
  }
  if (typeof type === 'function') {
    if (type.prototype?.isReactComponent) throw new Error('class components are not supported');
    renderNode(callComponent(() => type(props)), out);
    return;
  }
  throw new Error(`cannot render ${String(type)}`);
}

function callComponent(fn: () => unknown): unknown {
  const previous = internals.H;
  internals.H = oneShotDispatcher;
  try {
    return fn();
  } finally {
    internals.H = previous;
  }
}

/** Render `element` once into host nodes; the root holds them as children. */
export function render(element: React.ReactElement): HostNode {
  const children: Array<HostNode | string> = [];
  renderNode(element, children);
  return { type: 'root', props: {}, children };
}

/** Every host node below `node` (itself included) that `test` accepts, in tree order. */
export function findAll(node: HostNode, test: (n: HostNode) => boolean): HostNode[] {
  const out: HostNode[] = [];
  const walk = (n: HostNode) => {
    if (test(n)) out.push(n);
    for (const child of n.children) if (typeof child !== 'string') walk(child);
  };
  walk(node);
  return out;
}

export function byTestId(node: HostNode, id: string): HostNode[] {
  return findAll(node, (n) => n.props.testID === id);
}

export function oneByTestId(node: HostNode, id: string): HostNode {
  const found = byTestId(node, id);
  if (found.length !== 1) throw new Error(`expected one ${id}, found ${found.length}`);
  return found[0];
}

export function byLabel(node: HostNode, label: string | RegExp): HostNode[] {
  return findAll(node, (n) => typeof n.props.accessibilityLabel === 'string'
    && (typeof label === 'string' ? n.props.accessibilityLabel === label : label.test(n.props.accessibilityLabel)));
}

/** The text a node shows, its strings joined, Unicode isolates removed. */
export function textOf(node: HostNode | string): string {
  const raw = typeof node === 'string' ? node : node.children.map(textOf).join('');
  return raw.replace(/[⁦-⁩]/g, '');
}

/** The text with its isolates, to check direction marks. */
export function rawTextOf(node: HostNode | string): string {
  return typeof node === 'string' ? node : node.children.map(rawTextOf).join('');
}

/** Flattened style of a host node. */
export function styleOf(node: HostNode, state: { pressed?: boolean } = {}): Record<string, any> {
  const flatten = (style: unknown): Record<string, any> => {
    if (!style) return {};
    if (typeof style === 'function') return flatten(style({ pressed: !!state.pressed }));
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
    return style as Record<string, any>;
  };
  return flatten(node.props.style);
}

// ---------------------------------------------------------------------------
// hooks

function depsChanged(prev: unknown[] | undefined, next: unknown[] | undefined): boolean {
  if (!prev || !next) return true;
  return prev.length !== next.length || prev.some((value, i) => !Object.is(value, next[i]));
}

export interface HookResult<T> {
  readonly current: T;
  rerender: () => void;
  unmount: () => void;
  renders: () => number;
}

/**
 * Run `hook` like a component would: state survives renders, a state change
 * or store update renders again, effects run after each render and clean up
 * on deps change and unmount.
 */
export function renderHook<T>(hook: () => T): HookResult<T> {
  const slots: any[] = [];
  let index = 0;
  let result: T;
  let rendering = false;
  let dirty = false;
  let mounted = true;
  let count = 0;
  const pending: Array<() => void> = [];

  const schedule = () => {
    if (!mounted) return;
    if (rendering) {
      dirty = true;
      return;
    }
    run();
  };

  const effect = (fn: () => void | (() => void), deps?: unknown[]) => {
    const i = index++;
    const prev = slots[i] as { deps?: unknown[]; cleanup?: () => void } | undefined;
    if (prev && deps && !depsChanged(prev.deps, deps)) return;
    pending.push(() => {
      prev?.cleanup?.();
      const cleanup = fn();
      slots[i] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
    });
    if (!prev) slots[i] = { deps: undefined };
  };

  const dispatcher = {
    useState: (init: unknown) => {
      const i = index++;
      if (!(i in slots)) slots[i] = { value: typeof init === 'function' ? (init as () => unknown)() : init };
      const slot = slots[i];
      if (!slot.set) {
        slot.set = (value: unknown) => {
          const next = typeof value === 'function' ? (value as (v: unknown) => unknown)(slot.value) : value;
          if (Object.is(next, slot.value)) return;
          slot.value = next;
          schedule();
        };
      }
      return [slot.value, slot.set];
    },
    useReducer: (reducer: (s: unknown, a: unknown) => unknown, init: unknown, fn?: (a: unknown) => unknown) => {
      const i = index++;
      if (!(i in slots)) slots[i] = { value: fn ? fn(init) : init };
      const slot = slots[i];
      slot.dispatch ??= (action: unknown) => {
        const next = reducer(slot.value, action);
        if (Object.is(next, slot.value)) return;
        slot.value = next;
        schedule();
      };
      return [slot.value, slot.dispatch];
    },
    useMemo: (fn: () => unknown, deps?: unknown[]) => {
      const i = index++;
      const prev = slots[i];
      if (prev && deps && !depsChanged(prev.deps, deps)) return prev.value;
      const value = fn();
      slots[i] = { deps, value };
      return value;
    },
    useCallback: (fn: unknown, deps?: unknown[]) => dispatcher.useMemo(() => fn, deps),
    useRef: (current: unknown) => {
      const i = index++;
      if (!(i in slots)) slots[i] = { current };
      return slots[i];
    },
    useEffect: effect,
    useLayoutEffect: effect,
    useInsertionEffect: effect,
    useImperativeHandle: () => { index++; },
    useContext: (context: { _currentValue: unknown }) => context._currentValue,
    useSyncExternalStore: (subscribe: (cb: () => void) => () => void, getSnapshot: () => unknown) => {
      const i = index++;
      const value = getSnapshot();
      if (!slots[i]) {
        const slot = { value, unsubscribe: () => undefined as void };
        slots[i] = slot;
        slot.unsubscribe = subscribe(() => {
          const next = getSnapshot();
          if (Object.is(next, slot.value)) return;
          slot.value = next;
          schedule();
        });
      } else {
        slots[i].value = value;
      }
      return value;
    },
    useDebugValue: () => undefined,
    useId: () => `:r${index++}:`,
    useTransition: () => [false, (fn: () => void) => fn()],
    useDeferredValue: (value: unknown) => value,
  };

  function run() {
    let loops = 0;
    do {
      if (++loops > 50) throw new Error('renderHook: too many re-renders (a selector that returns a new object?)');
      dirty = false;
      rendering = true;
      index = 0;
      const previous = internals.H;
      internals.H = dispatcher;
      try {
        result = hook();
        count++;
      } finally {
        internals.H = previous;
        rendering = false;
      }
      while (pending.length > 0) {
        rendering = true;
        try {
          pending.shift()!();
        } finally {
          rendering = false;
        }
      }
    } while (dirty);
  }

  run();
  return {
    get current() { return result; },
    rerender: () => run(),
    unmount: () => {
      mounted = false;
      for (const slot of slots) {
        slot?.cleanup?.();
        slot?.unsubscribe?.();
      }
    },
    renders: () => count,
  };
}

/** Wait until `check` passes (it throws until then), flushing promises and timers in between. */
export async function waitFor(check: () => void, { timeout = 2000 } = {}): Promise<void> {
  // performance.now: tests fake Date.
  const started = performance.now();
  let last: unknown;
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      last = err;
    }
    if (performance.now() - started > timeout) throw last;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The react-native surface the cards use, as host components. */
export function reactNativeMock() {
  const host = (name: string) => name;
  return {
    View: host('View'),
    Text: host('Text'),
    Pressable: host('Pressable'),
    Image: host('Image'),
    ActivityIndicator: host('ActivityIndicator'),
    ScrollView: host('ScrollView'),
    Modal: host('Modal'),
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1, flatten: (s: unknown) => s },
    Platform: { OS: 'android', Version: 33, select: <T,>(spec: { default?: T; android?: T; ios?: T }) => spec.android ?? spec.default ?? spec.ios },
    I18nManager: { isRTL: false, allowRTL: () => undefined, forceRTL: () => undefined },
    Alert: { alert: vi.fn() },
    Linking: { openURL: vi.fn(async () => undefined) },
    Appearance: { getColorScheme: () => 'light', addChangeListener: () => ({ remove: () => undefined }) },
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
    useColorScheme: () => 'light',
    useWindowDimensions: () => ({ width: 400, height: 800, scale: 2, fontScale: 1 }),
    NativeModules: {},
    NativeEventEmitter: class { addListener() { return { remove: () => undefined }; } removeAllListeners() {} },
  };
}
