import React, { createContext, forwardRef, useCallback, useMemo, useRef } from 'react';
import {
  FlatList, Platform, RefreshControl, ScrollView, type FlatListProps, type LayoutChangeEvent,
  type ScrollViewProps, type StyleProp, type ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector, type NativeGesture } from 'react-native-gesture-handler';
import Animated, { Easing, LinearTransition } from 'react-native-reanimated';
import { createScrollLock, NO_SCROLL_LOCK, type ScrollLock } from './swipe-scroll-lock';

export const SwipeScrollLockContext = createContext<ScrollLock>(NO_SCROLL_LOCK);
export const SwipeScrollGestureContext = createContext<readonly NativeGesture[]>([]);

const ROW_SHIFT = LinearTransition.duration(300).easing(Easing.bezier(0.3, 0.5, 0.2, 1));
const ANDROID_REFRESH_STYLE: ViewStyle = { flexGrow: 1, flexShrink: 1 };

const ShiftingCell = forwardRef<Animated.View, {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onLayout?: (e: LayoutChangeEvent) => void;
}>(function ShiftingCell({ children, style, onLayout }, ref) {
  return (
    <Animated.View ref={ref} style={style} onLayout={onLayout} layout={ROW_SHIFT}>
      {children}
    </Animated.View>
  );
});

type ListScrollProps = ScrollViewProps & {
  gesture: NativeGesture;
  refreshGesture?: NativeGesture;
  onRefresh?: (() => void) | null;
  refreshing?: boolean | null;
  progressViewOffset?: number;
};

const ScrollWithGesture = forwardRef<ScrollView, ListScrollProps>(
  function ScrollWithGesture(
    { gesture, refreshGesture, onRefresh, refreshing, progressViewOffset, refreshControl, style, ...props },
    ref,
  ) {
    const control = refreshControl ?? (onRefresh ? (
      <RefreshControl
        refreshing={Boolean(refreshing)}
        onRefresh={onRefresh}
        progressViewOffset={progressViewOffset}
      />
    ) : undefined);
    if (Platform.OS === 'android' && control) {
      const controlStyle = (control.props as { style?: StyleProp<ViewStyle> })?.style;
      const scroll = (
        <GestureDetector gesture={gesture}>
          <ScrollView ref={ref} {...props} />
        </GestureDetector>
      );
      const wrapped = React.cloneElement(control, { style: [ANDROID_REFRESH_STYLE, style, controlStyle] }, scroll);
      return refreshGesture ? <GestureDetector gesture={refreshGesture}>{wrapped}</GestureDetector> : wrapped;
    }
    return (
      <GestureDetector gesture={gesture}>
        <ScrollView ref={ref} {...props} style={style} refreshControl={control} />
      </GestureDetector>
    );
  },
);

function SwipeLockedFlatListInner<T>(props: FlatListProps<T>, ref: React.ForwardedRef<FlatList<T>>) {
  const listRef = useRef<FlatList<T> | null>(null);
  const scrollEnabledRef = useRef(props.scrollEnabled !== false);
  scrollEnabledRef.current = props.scrollEnabled !== false;
  const setRef = useCallback((node: FlatList<T> | null) => {
    listRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  }, [ref]);
  const lock = useMemo(() => createScrollLock((locked) => {
    listRef.current?.setNativeProps({ scrollEnabled: !locked && scrollEnabledRef.current });
  }), []);
  const hasRefresh = props.refreshControl != null || props.onRefresh != null;
  const scrollGesture = useMemo(() => Gesture.Native().shouldCancelWhenOutside(false), []);
  const refreshGesture = useMemo(() => Gesture.Native().disallowInterruption(true).shouldCancelWhenOutside(false), []);
  const externalGestures = useMemo(
    () => (Platform.OS === 'android' && hasRefresh ? [scrollGesture, refreshGesture] : [scrollGesture]),
    [scrollGesture, refreshGesture, hasRefresh],
  );
  const renderScrollComponent = useCallback(
    (scrollProps: ScrollViewProps) => (
      <ScrollWithGesture gesture={scrollGesture} refreshGesture={refreshGesture} {...scrollProps} />
    ),
    [scrollGesture, refreshGesture],
  );
  return (
    <SwipeScrollGestureContext.Provider value={externalGestures}>
      <SwipeScrollLockContext.Provider value={lock}>
        <FlatList
          ref={setRef}
          {...props}
          CellRendererComponent={props.CellRendererComponent ?? ShiftingCell}
          renderScrollComponent={props.renderScrollComponent ?? renderScrollComponent}
        />
      </SwipeScrollLockContext.Provider>
    </SwipeScrollGestureContext.Provider>
  );
}

export const SwipeLockedFlatList = forwardRef(SwipeLockedFlatListInner) as <T>(
  props: FlatListProps<T> & { ref?: React.Ref<FlatList<T>> },
) => React.ReactElement;
