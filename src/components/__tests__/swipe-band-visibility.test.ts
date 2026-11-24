import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as swipeGesture from '../swipe-gesture';

const requireFromRoot = createRequire(path.resolve(__dirname, '..', '..', '..', 'package.json'));

interface SharedValueMock<T = unknown> {
  value: T;
  __listeners: Set<() => void>;
}

interface WorkletFn {
  (...args: unknown[]): unknown;
  __closure?: Record<string, unknown>;
  __workletHash?: number;
}

interface AnimatedStyleHandle {
  __animatedStyle: true;
  updater: WorkletFn;
  inputs: unknown[];
  subscribed: SharedValueMock[];
  deps: unknown[];
  current: Record<string, unknown>;
}

interface ElementNode {
  type: unknown;
  props: Record<string, unknown>;
}

const sharedValues = new WeakSet<object>();

function isSharedValue(value: unknown): value is SharedValueMock {
  return typeof value === 'object' && value !== null && sharedValues.has(value);
}

function extractMapperInputs(inputs: unknown, result: SharedValueMock[] = []): SharedValueMock[] {
  if (Array.isArray(inputs)) {
    for (const item of inputs) {
      if (item) extractMapperInputs(item, result);
    }
  } else if (isSharedValue(inputs)) {
    result.push(inputs);
  } else if (typeof inputs === 'object' && inputs !== null && Object.getPrototypeOf(inputs) === Object.prototype) {
    for (const value of Object.values(inputs as Record<string, unknown>)) {
      if (value) extractMapperInputs(value, result);
    }
  }
  return result;
}

function setSharedValue<T>(sv: SharedValueMock<T>, next: T): void {
  sv.value = next;
  for (const listener of sv.__listeners) listener();
}

function compileSwipeableRow(): string {
  const babel = requireFromRoot('@babel/core') as {
    transformSync: (code: string, opts: Record<string, unknown>) => { code?: string | null } | null;
  };
  const babelConfig = requireFromRoot('./babel.config.js') as (api: { cache: (v: boolean) => void }) => Record<string, unknown>;
  const filePath = path.resolve(__dirname, '..', 'SwipeableRow.tsx');
  const source = fs.readFileSync(filePath, 'utf8');
  const config = babelConfig({ cache: () => undefined });
  const result = babel.transformSync(source, {
    filename: filePath,
    babelrc: false,
    configFile: false,
    ...config,
    caller: { name: 'metro', bundler: 'metro', platform: 'ios' },
  });
  if (!result?.code) throw new Error('Failed to compile SwipeableRow.tsx');
  return result.code;
}

const compiledSource = compileSwipeableRow();

function mountSwipeableRow(initialProps: {
  leftAction: string;
  rightAction: string;
  mode?: 'instant' | 'reveal';
  context: { unread: boolean; starred: boolean; pinned: boolean; inJunk?: boolean };
}) {
  const states: unknown[] = [];
  const refs: Array<{ current: unknown }> = [];
  const memos: Array<{ value: unknown; deps: unknown[] | undefined }> = [];
  const animatedHandles: AnimatedStyleHandle[] = [];
  const allSharedValues: SharedValueMock[] = [];
  const springCallbacks: Array<(finished: boolean) => void> = [];
  let gestureCallbacks: Record<string, (...args: unknown[]) => unknown> = {};

  let stateIdx = 0;
  let refIdx = 0;
  let memoIdx = 0;
  let svIdx = 0;
  let styleIdx = 0;

  const sameDeps = (a: unknown[] | undefined, b: unknown[] | undefined): boolean =>
    Boolean(a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i])));

  const scrollLockContext = {};
  const scrollGestureContext = {};
  const reactMock = {
    __esModule: true,
    default: null as unknown,
    useState: <T,>(initial: T): [T, (next: T | ((prev: T) => T)) => void] => {
      const idx = stateIdx++;
      if (!(idx in states)) states[idx] = initial;
      const setState = (next: T | ((prev: T) => T)) => {
        states[idx] = typeof next === 'function' ? (next as (prev: T) => T)(states[idx] as T) : next;
      };
      return [states[idx] as T, setState];
    },
    useRef: <T,>(initial: T) => {
      const idx = refIdx++;
      if (!(idx in refs)) refs[idx] = { current: initial };
      return refs[idx];
    },
    useMemo: <T,>(factory: () => T, deps?: unknown[]): T => {
      const idx = memoIdx++;
      const prev = memos[idx];
      if (!prev || !sameDeps(prev.deps, deps)) {
        const value = factory();
        memos[idx] = { value, deps };
        return value;
      }
      return prev.value as T;
    },
    useEffect: () => undefined,
    useContext: (ctx: unknown) => (ctx === scrollGestureContext ? [] : { hold: () => () => undefined }),
    memo: <T,>(component: T) => component,
  };
  reactMock.default = reactMock;

  const makeElement = (type: unknown, props: Record<string, unknown>): ElementNode => ({ type, props });

  const makeIcon = (name: string) => Object.assign((props: Record<string, unknown>) => makeElement(name, props), { iconName: name });

  const labels: Record<string, string> = {
    'context_menu.mark_read': 'Mark as read',
    'context_menu.mark_unread': 'Mark as unread',
    'context_menu.archive': 'Archive',
    'context_menu.delete': 'Delete',
    'context_menu.star': 'Star',
    'context_menu.unstar': 'Unstar',
    'context_menu.pin': 'Pin',
    'context_menu.unpin': 'Unpin',
    'context_menu.not_spam': 'Not spam',
    'email_list.swipe_spam': 'Spam',
    'email_list.swipe_move': 'Move',
  };

  const reanimatedMock = {
    __esModule: true,
    default: { View: 'Animated.View' },
    Extrapolation: { CLAMP: 'clamp' },
    FadeIn: { duration: () => ({}) },
    FadeOut: { duration: () => ({}) },
    cancelAnimation: () => undefined,
    runOnJS: <T extends (...args: never[]) => unknown>(fn: T) => fn,
    withSpring: (toValue: number, _config?: unknown, callback?: (finished: boolean) => void) => {
      if (callback) springCallbacks.push(callback);
      return toValue;
    },
    withTiming: (toValue: number, _config?: unknown, callback?: (finished: boolean) => void) => {
      if (callback) springCallbacks.push(callback);
      return toValue;
    },
    interpolate: (value: number, input: number[], output: number[], extrapolation?: string) => {
      const [in0, in1] = input;
      const [out0, out1] = output;
      let t = (value - in0) / (in1 - in0);
      if (extrapolation === 'clamp') t = Math.min(1, Math.max(0, t));
      return out0 + (out1 - out0) * t;
    },
    interpolateColor: (value: number, _input: number[], output: string[]) => (value >= 0.5 ? output[1] : output[0]),
    useSharedValue: <T,>(initial: T): SharedValueMock<T> => {
      const idx = svIdx++;
      if (!(idx in allSharedValues)) {
        const sv: SharedValueMock<T> = { value: initial, __listeners: new Set() };
        sharedValues.add(sv);
        allSharedValues[idx] = sv;
      }
      return allSharedValues[idx] as SharedValueMock<T>;
    },
    useAnimatedStyle: (updater: WorkletFn, explicitDeps?: unknown[]): AnimatedStyleHandle => {
      const idx = styleIdx++;
      const inputs = Object.values(updater.__closure ?? {});
      const subscribed = extractMapperInputs(inputs);
      const deps = explicitDeps ? [...explicitDeps, updater.__workletHash] : [...inputs, updater.__workletHash];
      const existing = animatedHandles[idx];
      if (!existing) {
        const handle: AnimatedStyleHandle = {
          __animatedStyle: true,
          updater,
          inputs,
          subscribed,
          deps,
          current: updater() as Record<string, unknown>,
        };
        const run = () => {
          handle.current = handle.updater() as Record<string, unknown>;
        };
        for (const sv of subscribed) sv.__listeners.add(run);
        animatedHandles[idx] = handle;
        return handle;
      }
      if (!sameDeps(existing.deps, deps)) {
        existing.updater = updater;
        existing.inputs = inputs;
        existing.subscribed = subscribed;
        existing.deps = deps;
        existing.current = updater() as Record<string, unknown>;
        const run = () => {
          existing.current = existing.updater() as Record<string, unknown>;
        };
        for (const sv of subscribed) sv.__listeners.add(run);
      }
      return existing;
    },
  };

  const panBuilder = () => {
    const callbacks: Record<string, (...args: unknown[]) => unknown> = {};
    const api = {
      enabled: () => api,
      manualActivation: () => api,
      blocksExternalGesture: () => api,
      activeOffsetX: () => api,
      failOffsetY: () => api,
      onTouchesDown: (cb: (...args: unknown[]) => unknown) => { callbacks.onTouchesDown = cb; return api; },
      onTouchesMove: (cb: (...args: unknown[]) => unknown) => { callbacks.onTouchesMove = cb; return api; },
      onTouchesUp: (cb: (...args: unknown[]) => unknown) => { callbacks.onTouchesUp = cb; return api; },
      onTouchesCancelled: (cb: (...args: unknown[]) => unknown) => { callbacks.onTouchesCancelled = cb; return api; },
      onBegin: (cb: (...args: unknown[]) => unknown) => { callbacks.onBegin = cb; return api; },
      onStart: (cb: (...args: unknown[]) => unknown) => { callbacks.onStart = cb; return api; },
      onUpdate: (cb: (...args: unknown[]) => unknown) => { callbacks.onUpdate = cb; return api; },
      onEnd: (cb: (...args: unknown[]) => unknown) => { callbacks.onEnd = cb; return api; },
      onFinalize: (cb: (...args: unknown[]) => unknown) => { callbacks.onFinalize = cb; return api; },
      __callbacks: callbacks,
    };
    return api;
  };

  const customRequire = (id: string): unknown => {
    if (id === 'react') return reactMock;
    if (id === 'react/jsx-runtime') return { jsx: makeElement, jsxs: makeElement };
    if (id === 'react-native') {
      return {
        View: 'View',
        Text: 'Text',
        Pressable: 'Pressable',
        StyleSheet: { create: <T,>(s: T) => s, absoluteFill: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 } },
        Dimensions: { get: () => ({ width: 390, height: 844 }) },
      };
    }
    if (id === 'react-native-gesture-handler') {
      return {
        Gesture: { Pan: panBuilder },
        GestureDetector: 'GestureDetector',
      };
    }
    if (id === 'react-native-reanimated') return reanimatedMock;
    if (id === './icons') {
      return {
        Archive: makeIcon('Archive'),
        Trash2: makeIcon('Trash2'),
        ShieldAlert: makeIcon('ShieldAlert'),
        ShieldCheck: makeIcon('ShieldCheck'),
        MailOpen: makeIcon('MailOpen'),
        Mail: makeIcon('Mail'),
        Star: makeIcon('Star'),
        Pin: makeIcon('Pin'),
        PinOff: makeIcon('PinOff'),
        FolderInput: makeIcon('FolderInput'),
      };
    }
    if (id === '../theme/tokens') return { typography: { caption: { fontSize: 12, lineHeight: 16 } } };
    if (id === '../theme/colors') return { useColors: () => ({ background: '#0a0a0a' }) };
    if (id === '../stores/locale-store') {
      return {
        useLocaleStore: (selector: (s: { t: (k: string, fb?: string) => string }) => unknown) =>
          selector({ t: (key: string, fallback?: string) => labels[key] ?? fallback ?? key }),
      };
    }
    if (id === '../lib/haptics') return { haptic: () => undefined };
    if (id === './swipe-gesture') return swipeGesture;
    if (id === './SwipeLockedFlatList') {
      return { SwipeScrollLockContext: scrollLockContext, SwipeScrollGestureContext: scrollGestureContext };
    }
    return requireFromRoot(id);
  };

  const moduleObj: { exports: Record<string, unknown> } = { exports: {} };
  const factory = new Function('require', 'exports', 'module', compiledSource);
  factory(customRequire, moduleObj.exports, moduleObj);
  const SwipeableRow = moduleObj.exports.SwipeableRow as (props: Record<string, unknown>) => ElementNode;

  const firedActions: string[] = [];
  let props: Record<string, unknown> = {
    ...initialProps,
    onAction: (action: string) => firedActions.push(action),
    children: makeElement('RowContent', {}),
  };

  const render = (nextProps?: Partial<typeof initialProps>): ElementNode => {
    if (nextProps) props = { ...props, ...nextProps };
    stateIdx = 0;
    refIdx = 0;
    memoIdx = 0;
    svIdx = 0;
    styleIdx = 0;
    const tree = SwipeableRow(props);
    if (tree.type === 'GestureDetector') {
      const gesture = tree.props.gesture as { __callbacks?: Record<string, (...args: unknown[]) => unknown> };
      if (gesture?.__callbacks) gestureCallbacks = gesture.__callbacks;
    }
    return tree;
  };

  const tree = render();
  return {
    tree,
    render,
    getGesture: () => gestureCallbacks,
    getSharedValues: () => ({
      tx: allSharedValues[0] as SharedValueMock<number>,
      armed: allSharedValues[1] as SharedValueMock<boolean>,
      armedProgress: allSharedValues[2] as SharedValueMock<number>,
    }),
    getAnimatedHandles: () => animatedHandles,
    getSpringCallbacks: () => springCallbacks,
    getFiredActions: () => firedActions,
  };
}

function collectNodes(node: unknown, out: ElementNode[] = []): ElementNode[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out);
    return out;
  }
  const el = node as ElementNode;
  if ('type' in el && 'props' in el) {
    out.push(el);
    collectNodes(el.props.children, out);
  }
  return out;
}

function findAnimatedHandle(styleProp: unknown): AnimatedStyleHandle | undefined {
  const list = Array.isArray(styleProp) ? styleProp : [styleProp];
  for (const item of list) {
    if (item && typeof item === 'object' && '__animatedStyle' in item) {
      return item as AnimatedStyleHandle;
    }
  }
  return undefined;
}

function findBandForLabel(tree: ElementNode, expectedLabel: string) {
  const nodes = collectNodes(tree);
  for (const node of nodes) {
    const children = collectNodes(node);
    const hasLabel = children.some((n) => n.type === 'Text' && n.props.children === expectedLabel);
    if (!hasLabel) continue;
    const iconChild = children.find((n) => typeof n.type === 'function' && 'iconName' in n.type);
    const handle = findAnimatedHandle(node.props.style);
    if (handle && iconChild && node.props.style && Array.isArray(node.props.style) && (node.props.style[0] as Record<string, unknown>)?.gap === 4) {
      return {
        node,
        iconHandle: handle,
        iconName: (iconChild.type as { iconName: string }).iconName,
        label: expectedLabel,
      };
    }
  }
  return null;
}

function findBandWrapperForLabel(tree: ElementNode, expectedLabel: string): AnimatedStyleHandle | undefined {
  const nodes = collectNodes(tree);
  for (const node of nodes) {
    if (node.type !== 'Animated.View' || node.props.pointerEvents !== 'none') continue;
    const children = collectNodes(node);
    if (children.some((n) => n.type === 'Text' && n.props.children === expectedLabel)) {
      return findAnimatedHandle(node.props.style);
    }
  }
  return undefined;
}

describe('swipe action band visibility', () => {
  it('reveals the Mark as read icon and label when swiping right, not just background color', () => {
    const row = mountSwipeableRow({
      leftAction: 'archive',
      rightAction: 'read',
      mode: 'instant',
      context: { unread: true, starred: false, pinned: false },
    });

    row.getGesture().onBegin?.();
    const mountedTree = row.render();

    const band = findBandForLabel(mountedTree, 'Mark as read');
    const bandWrapper = findBandWrapperForLabel(mountedTree, 'Mark as read');
    expect(band).not.toBeNull();
    expect(band?.iconName).toBe('MailOpen');
    expect(bandWrapper).toBeDefined();

    const { tx, armedProgress } = row.getSharedValues();
    expect(band!.iconHandle.current.opacity).toBe(0);

    setSharedValue(tx, 48);
    expect(bandWrapper!.current.opacity).toBe(1);
    expect(band!.iconHandle.current.opacity).toBe(1);

    setSharedValue(tx, 140);
    setSharedValue(armedProgress, 1);
    expect(band!.iconHandle.current.opacity).toBe(1);
    const transforms = band!.iconHandle.current.transform as Array<Record<string, number>>;
    expect(transforms.find((t) => 'translateX' in t)?.translateX).toBeGreaterThan(0);
    expect(transforms.find((t) => 'scale' in t)?.scale).toBeGreaterThan(1);
  });

  it('reveals the Archive icon and label when swiping left, not just background color', () => {
    const row = mountSwipeableRow({
      leftAction: 'archive',
      rightAction: 'read',
      mode: 'instant',
      context: { unread: true, starred: false, pinned: false },
    });

    row.getGesture().onBegin?.();
    const mountedTree = row.render();

    const archiveBand = findBandForLabel(mountedTree, 'Archive');
    const readBand = findBandForLabel(mountedTree, 'Mark as read');
    const archiveWrapper = findBandWrapperForLabel(mountedTree, 'Archive');
    const readWrapper = findBandWrapperForLabel(mountedTree, 'Mark as read');
    expect(archiveBand).not.toBeNull();
    expect(archiveBand?.iconName).toBe('Archive');
    expect(archiveWrapper).toBeDefined();
    expect(readWrapper).toBeDefined();

    const { tx, armedProgress } = row.getSharedValues();
    setSharedValue(tx, -48);
    expect(archiveWrapper!.current.opacity).toBe(1);
    expect(readWrapper!.current.opacity).toBe(0);
    expect(archiveBand!.iconHandle.current.opacity).toBe(1);
    expect(readBand!.iconHandle.current.opacity).toBe(0);

    setSharedValue(tx, -140);
    setSharedValue(armedProgress, 1);
    expect(archiveBand!.iconHandle.current.opacity).toBe(1);
    const transforms = archiveBand!.iconHandle.current.transform as Array<Record<string, number>>;
    expect(transforms.find((t) => 'translateX' in t)?.translateX).toBeLessThan(0);
    expect(transforms.find((t) => 'scale' in t)?.scale).toBeGreaterThan(1);
  });

  it('shows Mark as unread and the closed-mail icon when swiping an already-read row right', () => {
    const row = mountSwipeableRow({
      leftAction: 'archive',
      rightAction: 'read',
      mode: 'instant',
      context: { unread: false, starred: false, pinned: false },
    });

    row.getGesture().onBegin?.();
    const mountedTree = row.render();

    const band = findBandForLabel(mountedTree, 'Mark as unread');
    expect(band).not.toBeNull();
    expect(band?.iconName).toBe('Mail');

    const { tx } = row.getSharedValues();
    setSharedValue(tx, 60);
    expect(band!.iconHandle.current.opacity).toBe(1);
  });

  it('fits wide labels inside the exposed band at both the disarm and commit thresholds in both swipe directions', () => {
    const row = mountSwipeableRow({
      leftAction: 'read',
      rightAction: 'read',
      mode: 'instant',
      context: { unread: false, starred: false, pinned: false },
    });

    row.getGesture().onBegin?.();
    const mountedTree = row.render();
    const nodes = collectNodes(mountedTree);
    const wideBands = nodes.filter((node) => {
      const children = collectNodes(node);
      const hasLabel = children.some((n) => n.type === 'Text' && n.props.children === 'Mark as unread');
      return hasLabel && Array.isArray(node.props.style) && (node.props.style[0] as Record<string, unknown>)?.gap === 4;
    });
    expect(wideBands).toHaveLength(2);

    const labelWidth = 92;
    for (const bandNode of wideBands) {
      const onLayout = bandNode.props.onLayout as ((e: { nativeEvent: { layout: { width: number } } }) => void) | undefined;
      onLayout?.({ nativeEvent: { layout: { width: labelWidth } } });
    }

    const bandInstant = nodes.find(
      (n) => Array.isArray(n.props.style) && typeof (n.props.style[0] as Record<string, unknown>)?.paddingHorizontal === 'number',
    );
    const pad = ((bandInstant?.props.style as Array<Record<string, number>>)?.[0]?.paddingHorizontal) ?? 16;
    const { tx, armedProgress } = row.getSharedValues();

    for (const threshold of [swipeGesture.DISARM_THRESHOLD, swipeGesture.COMMIT_THRESHOLD]) {
      for (const [sign, bandNode] of [[1, wideBands[0]], [-1, wideBands[1]]] as const) {
        const handle = findAnimatedHandle(bandNode.props.style)!;
        setSharedValue(tx, sign * threshold);
        setSharedValue(armedProgress, 1);

        const transforms = handle.current.transform as Array<Record<string, number>>;
        const translateX = transforms.find((t) => 'translateX' in t)?.translateX ?? 0;
        const scale = transforms.find((t) => 'scale' in t)?.scale ?? 1;
        const center = pad + labelWidth / 2 + sign * translateX;
        const half = (labelWidth * scale) / 2;
        expect(center - half).toBeGreaterThanOrEqual(0);
        expect(center + half).toBeLessThanOrEqual(threshold);
      }
    }
  });

  it('resets the armed state when reversing directly across zero without an intermediate zero frame', () => {
    const row = mountSwipeableRow({
      leftAction: 'archive',
      rightAction: 'read',
      mode: 'instant',
      context: { unread: true, starred: false, pinned: false },
    });

    const gesture = row.getGesture();
    gesture.onBegin?.();
    gesture.onStart?.();
    gesture.onUpdate?.({ translationX: 108, translationY: 0 });
    expect(row.getSharedValues().armed.value).toBe(true);

    gesture.onUpdate?.({ translationX: -93, translationY: 0 });
    expect(row.getSharedValues().tx.value).toBe(-85);
    expect(row.getSharedValues().armed.value).toBe(false);

    gesture.onEnd?.({ translationY: 0, velocityX: 0 }, true);
    expect(row.getFiredActions()).toEqual([]);
  });

  it('keeps wider labels like Mark as unread from sliding under the row edge when riding past commit', () => {
    const row = mountSwipeableRow({
      leftAction: 'archive',
      rightAction: 'read',
      mode: 'instant',
      context: { unread: false, starred: false, pinned: false },
    });

    row.getGesture().onBegin?.();
    const mountedTree = row.render();

    const band = findBandForLabel(mountedTree, 'Mark as unread');
    expect(band).not.toBeNull();

    const labelWidth = 92;
    const onLayout = band!.node.props.onLayout as ((e: { nativeEvent: { layout: { width: number } } }) => void) | undefined;
    onLayout?.({ nativeEvent: { layout: { width: labelWidth } } });

    const { tx, armedProgress } = row.getSharedValues();
    const reach = 180;
    setSharedValue(tx, reach);
    setSharedValue(armedProgress, 1);

    const transforms = band!.iconHandle.current.transform as Array<Record<string, number>>;
    const translateX = transforms.find((t) => 'translateX' in t)?.translateX ?? 0;
    const scale = transforms.find((t) => 'scale' in t)?.scale ?? 1;
    const bandInstant = collectNodes(mountedTree).find(
      (n) => Array.isArray(n.props.style) && typeof (n.props.style[0] as Record<string, unknown>)?.paddingHorizontal === 'number',
    );
    const pad = ((bandInstant?.props.style as Array<Record<string, number>>)?.[0]?.paddingHorizontal) ?? 24;
    const rightEdge = pad + labelWidth * (1 + (scale - 1) / 2) + translateX;
    expect(rightEdge).toBeLessThanOrEqual(reach - 12);
    expect(translateX).toBeGreaterThan(0);
  });

  it('subscribes every animated style directly to its shared values without restarting icon mappers on band mount', () => {
    const row = mountSwipeableRow({
      leftAction: 'archive',
      rightAction: 'read',
      mode: 'instant',
      context: { unread: true, starred: false, pinned: false },
    });

    const { tx, armedProgress } = row.getSharedValues();
    const initialHandles = row.getAnimatedHandles();
    const initialDeps = initialHandles.map((h) => [...h.deps]);

    for (const handle of initialHandles) {
      expect(handle.subscribed).toContain(tx);
    }

    row.getGesture().onBegin?.();
    const mountedTree = row.render();
    const readBand = findBandForLabel(mountedTree, 'Mark as read')!;
    const archiveBand = findBandForLabel(mountedTree, 'Archive')!;

    expect(readBand.iconHandle.subscribed).toContain(tx);
    expect(readBand.iconHandle.subscribed).toContain(armedProgress);
    expect(archiveBand.iconHandle.subscribed).toContain(tx);
    expect(archiveBand.iconHandle.subscribed).toContain(armedProgress);

    const readIdx = initialHandles.indexOf(readBand.iconHandle);
    const archiveIdx = initialHandles.indexOf(archiveBand.iconHandle);
    expect(readBand.iconHandle.deps).toEqual(initialDeps[readIdx]);
    expect(archiveBand.iconHandle.deps).toEqual(initialDeps[archiveIdx]);
  });

  it('keeps the action bands mounted if the user touches down again just as a settling spring finishes', () => {
    const row = mountSwipeableRow({
      leftAction: 'archive',
      rightAction: 'read',
      mode: 'instant',
      context: { unread: true, starred: false, pinned: false },
    });

    const gesture = row.getGesture();
    gesture.onBegin?.();
    gesture.onStart?.();
    gesture.onUpdate?.({ translationX: 40, translationY: 0 });
    gesture.onEnd?.({ translationY: 0, velocityX: 0 }, true);
    gesture.onFinalize?.();

    const settleCallback = row.getSpringCallbacks().at(-1);
    expect(settleCallback).toBeDefined();

    gesture.onBegin?.();
    settleCallback!(true);

    const treeAfterTouch = row.render();
    expect(findBandForLabel(treeAfterTouch, 'Mark as read')).not.toBeNull();
    expect(findBandForLabel(treeAfterTouch, 'Archive')).not.toBeNull();
  });

  it('does not flash the opposite band in full armed color when shaking quickly across zero', () => {
    const row = mountSwipeableRow({
      leftAction: 'archive',
      rightAction: 'read',
      mode: 'instant',
      context: { unread: true, starred: false, pinned: false },
    });

    const gesture = row.getGesture();
    gesture.onBegin?.();
    const mountedTree = row.render();
    const fillNode = collectNodes(mountedTree).find(
      (n) => n.type === 'Animated.View' && n.props.pointerEvents === 'none' && !n.props.children,
    );
    const fillHandle = findAnimatedHandle(fillNode?.props.style);
    expect(fillHandle).toBeDefined();

    const { tx, armedProgress } = row.getSharedValues();
    setSharedValue(tx, -30);
    setSharedValue(armedProgress, 0);
    const mutedArchiveColor = fillHandle!.current.backgroundColor;

    setSharedValue(tx, 0);
    gesture.onStart?.();
    gesture.onUpdate?.({ translationX: 120, translationY: 0 });
    setSharedValue(armedProgress, 1);

    setSharedValue(tx, -25);
    expect(fillHandle!.current.backgroundColor).toBe(mutedArchiveColor);

    gesture.onUpdate?.({ translationX: -30, translationY: 0 });
    expect(armedProgress.value).toBe(0);
    expect(fillHandle!.current.backgroundColor).toBe(mutedArchiveColor);
  });
});
