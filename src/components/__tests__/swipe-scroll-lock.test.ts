import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createScrollLock } from '../swipe-scroll-lock';

const requireFromRoot = createRequire(path.resolve(__dirname, '..', '..', '..', 'package.json'));
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

describe('createScrollLock', () => {
  it('stops the list scrolling while a row is swiped and lets it scroll again on release', () => {
    const onChange = vi.fn();
    const lock = createScrollLock(onChange);
    const release = lock.hold();
    expect(onChange).toHaveBeenLastCalledWith(true);
    release();
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('keeps the list still until every swiping row lets go', () => {
    const onChange = vi.fn();
    const lock = createScrollLock(onChange);
    const a = lock.hold();
    const b = lock.hold();
    a();
    expect(onChange).toHaveBeenLastCalledWith(true);
    b();
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('cannot leave the list frozen when a row lets go twice', () => {
    const onChange = vi.fn();
    const lock = createScrollLock(onChange);
    const a = lock.hold();
    a();
    a();
    const b = lock.hold();
    expect(onChange).toHaveBeenLastCalledWith(true);
    b();
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
});

describe('swipe scroll lock wiring', () => {
  it('holds the lock from the moment a swipe starts until it ends or the row goes away', () => {
    const row = read('components/SwipeableRow.tsx');
    expect(row).toMatch(/useContext\(SwipeScrollLockContext\)/);
    expect(row).toMatch(/\.onStart\(\(\) => \{[^}]*runOnJS\(begin\)\(\)/);
    expect(row).toMatch(/\.onFinalize\(\(\) => \{[^}]*runOnJS\(releaseScroll\)\(\)/);
    expect(row).toMatch(/useEffect\(\(\) => releaseScroll, \[\]\)/);
  });

  it('locks the list without re-rendering it', () => {
    const list = read('components/SwipeLockedFlatList.tsx');
    expect(list).toMatch(/setNativeProps\(\{ scrollEnabled/);
    expect(list).not.toMatch(/useState/);
  });

  it('applies to the folder list and the unified views', () => {
    for (const screen of ['screens/EmailListScreen.tsx', 'screens/UnifiedInboxScreen.tsx']) {
      const src = read(screen);
      expect(src).toMatch(/<SwipeLockedFlatList\s+ref=\{listRef\}/);
    }
  });

  it('preserves pull-to-refresh on iOS and keeps RefreshControl outside the scroll GestureDetector on Android', () => {
    const babel = requireFromRoot('@babel/core') as {
      transformSync: (code: string, opts: Record<string, unknown>) => { code?: string | null } | null;
    };
    const babelConfig = requireFromRoot('./babel.config.js') as (api: { cache: (v: boolean) => void }) => Record<string, unknown>;
    const filePath = path.resolve(__dirname, '..', 'SwipeLockedFlatList.tsx');
    const compiled = babel.transformSync(fs.readFileSync(filePath, 'utf8'), {
      filename: filePath,
      babelrc: false,
      configFile: false,
      ...babelConfig({ cache: () => undefined }),
      caller: { name: 'metro', bundler: 'metro', platform: 'ios' },
    })?.code;
    expect(compiled).toBeTruthy();

    type El = { type: unknown; props: Record<string, unknown> };
    const makeEl = (type: unknown, props: Record<string, unknown>): El => ({ type, props });
    const cloneEl = (el: El, props: Record<string, unknown>, children?: unknown): El => ({
      type: el.type,
      props: { ...el.props, ...props, ...(children !== undefined ? { children } : {}) },
    });

    const loadForPlatform = (os: 'ios' | 'android') => {
      const reactMock = {
        __esModule: true,
        default: null as unknown,
        cloneElement: cloneEl,
        createContext: (value: unknown) => ({ Provider: 'Provider', value }),
        forwardRef: <T,>(fn: T) => fn,
        useCallback: <T,>(fn: T) => fn,
        useMemo: <T,>(fn: () => T) => fn(),
        useRef: <T,>(current: T) => ({ current }),
      };
      reactMock.default = reactMock;
      let nextGestureId = 0;
      const makeNativeGesture = () => {
        const g = {
          id: ++nextGestureId,
          shouldCancelWhenOutside: () => g,
          disallowInterruption: () => g,
        };
        return g;
      };
      const customRequire = (id: string): unknown => {
        if (id === 'react') return reactMock;
        if (id === 'react/jsx-runtime') return { jsx: makeEl, jsxs: makeEl };
        if (id === 'react-native') {
          return {
            FlatList: 'FlatList',
            Platform: { OS: os },
            RefreshControl: 'RefreshControl',
            ScrollView: 'ScrollView',
          };
        }
        if (id === 'react-native-gesture-handler') {
          return { Gesture: { Native: makeNativeGesture }, GestureDetector: 'GestureDetector' };
        }
        if (id === 'react-native-reanimated') {
          const linear = { duration: () => ({ easing: () => ({}) }) };
          return { __esModule: true, default: { View: 'Animated.View' }, Easing: { bezier: () => ({}) }, LinearTransition: linear };
        }
        if (id === './swipe-scroll-lock') return { createScrollLock, NO_SCROLL_LOCK: { hold: () => () => undefined } };
        return requireFromRoot(id);
      };
      const mod: { exports: Record<string, unknown> } = { exports: {} };
      new Function('require', 'exports', 'module', compiled!)(customRequire, mod.exports, mod);
      return mod.exports.SwipeLockedFlatList as (props: Record<string, unknown>, ref: unknown) => El;
    };

    const renderList = (os: 'ios' | 'android', listProps: Record<string, unknown>, scrollProps: Record<string, unknown>) => {
      const SwipeLockedFlatList = loadForPlatform(os);
      const gestureProvider = SwipeLockedFlatList({ data: [], renderItem: () => null, ...listProps }, null);
      const flatList = ((gestureProvider.props.children as El).props.children as El);
      const renderScroll = flatList.props.renderScrollComponent as (sp: Record<string, unknown>) => El;
      const wrapperEl = renderScroll(scrollProps);
      const rendered = (wrapperEl.type as (p: Record<string, unknown>, r: unknown) => El)(wrapperEl.props, null);
      return { contextValue: gestureProvider.props.value as unknown[], rendered };
    };

    const onRefresh = vi.fn();
    const iosDefault = renderList('ios', { onRefresh, refreshing: true }, { onRefresh, refreshing: true, progressViewOffset: 24 });
    expect(iosDefault.rendered.type).toBe('GestureDetector');
    const iosScroll = iosDefault.rendered.props.children as El;
    expect(iosScroll.type).toBe('ScrollView');
    const iosControl = iosScroll.props.refreshControl as El;
    expect(iosControl.type).toBe('RefreshControl');
    expect(iosControl.props).toEqual({ refreshing: true, onRefresh, progressViewOffset: 24 });
    expect(iosDefault.contextValue).toHaveLength(1);

    const customControl = makeEl('RefreshControl', { refreshing: false, tintColor: '#fff' });
    const iosExplicit = renderList('ios', { refreshControl: customControl }, { onRefresh, refreshing: true, refreshControl: customControl });
    expect((iosExplicit.rendered.props.children as El).props.refreshControl).toBe(customControl);

    const iosNone = renderList('ios', {}, {});
    expect((iosNone.rendered.props.children as El).props.refreshControl).toBeUndefined();

    const androidDefault = renderList('android', { onRefresh, refreshing: true }, { onRefresh, refreshing: true, progressViewOffset: 24 });
    expect(androidDefault.rendered.type).toBe('GestureDetector');
    const androidRefresh = androidDefault.rendered.props.children as El;
    expect(androidRefresh.type).toBe('RefreshControl');
    expect(androidRefresh.props.onRefresh).toBe(onRefresh);
    expect(androidRefresh.props.refreshing).toBe(true);
    expect(androidRefresh.props.progressViewOffset).toBe(24);
    const androidScrollDetector = androidRefresh.props.children as El;
    expect(androidScrollDetector.type).toBe('GestureDetector');
    expect(androidScrollDetector.props.gesture).not.toBe(androidDefault.rendered.props.gesture);
    const androidScroll = androidScrollDetector.props.children as El;
    expect(androidScroll.type).toBe('ScrollView');
    expect(androidScroll.props.refreshControl).toBeUndefined();
    expect(androidDefault.contextValue).toEqual([androidScrollDetector.props.gesture, androidDefault.rendered.props.gesture]);
  });
});
