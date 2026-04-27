import React from 'react';
import { Animated, PanResponder } from 'react-native';

interface Options {
  /** Animated value driving the sheet's translateY. Resting (open) position is 0. */
  slideY: Animated.Value;
  /** Off-screen target the sheet animates to when dismissed. */
  closedY: number;
  /** Called when the gesture commits a dismissal. */
  onClose: () => void;
  /** Pixels of downward drag needed to commit a dismiss on release. */
  closeDistance?: number;
  /** Downward velocity (px/ms) that commits a dismiss regardless of distance. */
  closeVelocity?: number;
}

/**
 * Wires drag-to-dismiss on a bottom sheet's grab handle. Spread the returned
 * panHandlers on the handle/header area — not the scrollable body — so vertical
 * scrolling inside the sheet is not intercepted.
 */
export function useSheetDrag({
  slideY,
  closedY,
  onClose,
  closeDistance = 100,
  closeVelocity = 0.6,
}: Options) {
  const startRef = React.useRef(0);

  const panResponder = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, g) =>
          Math.abs(g.dy) > 4 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderGrant: () => {
          slideY.stopAnimation((v) => {
            startRef.current = v;
          });
        },
        onPanResponderMove: (_, g) => {
          const next = startRef.current + Math.max(0, g.dy);
          slideY.setValue(next);
        },
        onPanResponderRelease: (_, g) => {
          const traveled = startRef.current + Math.max(0, g.dy);
          if (traveled > closeDistance || g.vy > closeVelocity) {
            Animated.timing(slideY, {
              toValue: closedY,
              duration: 180,
              useNativeDriver: true,
            }).start(({ finished }) => {
              if (finished) onClose();
            });
          } else {
            Animated.spring(slideY, {
              toValue: 0,
              useNativeDriver: true,
              bounciness: 0,
            }).start();
          }
        },
        onPanResponderTerminate: () => {
          Animated.spring(slideY, {
            toValue: 0,
            useNativeDriver: true,
            bounciness: 0,
          }).start();
        },
      }),
    [slideY, closedY, onClose, closeDistance, closeVelocity],
  );

  return panResponder.panHandlers;
}
