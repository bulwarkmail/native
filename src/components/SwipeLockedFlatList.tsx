import React, { createContext, forwardRef, useCallback, useMemo, useRef } from 'react';
import { FlatList, type FlatListProps, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, LinearTransition } from 'react-native-reanimated';
import { createScrollLock, NO_SCROLL_LOCK, type ScrollLock } from './swipe-scroll-lock';

export const SwipeScrollLockContext = createContext<ScrollLock>(NO_SCROLL_LOCK);

const ROW_SHIFT = LinearTransition.duration(300).easing(Easing.bezier(0.3, 0.5, 0.2, 1));

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
  return (
    <SwipeScrollLockContext.Provider value={lock}>
      <FlatList ref={setRef} {...props} CellRendererComponent={props.CellRendererComponent ?? ShiftingCell} />
    </SwipeScrollLockContext.Provider>
  );
}

export const SwipeLockedFlatList = forwardRef(SwipeLockedFlatListInner) as <T>(
  props: FlatListProps<T> & { ref?: React.Ref<FlatList<T>> },
) => React.ReactElement;
