import React from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { EventBlockColors } from '../../lib/event-colors';

// Events in the week and day grids, shared by the paged WeekView and the
// scrolling TimeGridScrollView. Every event is a solid block of its calendar
// colour with a label colour computed from it; declined and cancelled ones
// are outlined on the page ground with a struck-through title
// (repos/branding/APP.md, "Calendar events"). Callers get the colours from
// eventBlockColors().

/** Corner radius of event blocks and bars. */
export const EVENT_RADIUS = 2;

/** Timed blocks this long or longer show their start time under the title. */
export const TIME_LINE_MIN_MINUTES = 45;

// Corners on a side the event continues past (the day before or after, the
// week before or after) stay square.
function corners(
  axis: 'vertical' | 'horizontal',
  continuesBefore: boolean,
  continuesAfter: boolean,
  r: number,
): ViewStyle {
  const before = continuesBefore ? 0 : r;
  const after = continuesAfter ? 0 : r;
  return axis === 'vertical'
    ? {
      borderTopLeftRadius: before,
      borderTopRightRadius: before,
      borderBottomLeftRadius: after,
      borderBottomRightRadius: after,
    }
    : {
      borderTopLeftRadius: before,
      borderBottomLeftRadius: before,
      borderTopRightRadius: after,
      borderBottomRightRadius: after,
    };
}

interface TimedEventBlockProps {
  title: string;
  /** Start time for the second line; null leaves it out. */
  timeLabel: string | null;
  colors: EventBlockColors;
  /** Page ground: a 1px ring in it keeps overlapping blocks apart. */
  ringColor: string;
  /** The event started on an earlier day (square top corners). */
  continuesBefore: boolean;
  /** The event runs into the next day (square bottom corners). */
  continuesAfter: boolean;
  /** Position and size in the day column. */
  style: StyleProp<ViewStyle>;
  onPress?: () => void;
}

/** A timed event in a day column. */
export function TimedEventBlock({
  title,
  timeLabel,
  colors,
  ringColor,
  continuesBefore,
  continuesAfter,
  style,
  onPress,
}: TimedEventBlockProps) {
  const inactive = colors.border !== null;
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.block,
        corners('vertical', continuesBefore, continuesAfter, EVENT_RADIUS),
        { backgroundColor: colors.fill, borderColor: ringColor },
        style,
      ]}
    >
      {inactive && (
        // The calendar-coloured outline sits inside the ring.
        <View
          pointerEvents="none"
          style={[
            styles.outline,
            corners('vertical', continuesBefore, continuesAfter, EVENT_RADIUS - 1),
            { borderColor: colors.border ?? undefined },
          ]}
        />
      )}
      <Text
        style={[styles.blockTitle, { color: colors.text }, inactive && styles.struck]}
        numberOfLines={1}
      >
        {title}
      </Text>
      {timeLabel !== null && (
        <Text style={[styles.blockTime, { color: colors.text }]} numberOfLines={1}>
          {timeLabel}
        </Text>
      )}
    </Pressable>
  );
}

interface AllDayEventBarProps {
  title: string;
  colors: EventBlockColors;
  /** The event runs in from the week before (square left corners). */
  continuesBefore: boolean;
  /** The event runs on into the week after (square right corners). */
  continuesAfter: boolean;
  /** Position and size in the all-day strip. */
  style: StyleProp<ViewStyle>;
  onPress?: () => void;
}

/** An all-day or multi-day event in the strip above the grid. */
export function AllDayEventBar({
  title,
  colors,
  continuesBefore,
  continuesAfter,
  style,
  onPress,
}: AllDayEventBarProps) {
  const inactive = colors.border !== null;
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.bar,
        corners('horizontal', continuesBefore, continuesAfter, EVENT_RADIUS),
        { backgroundColor: colors.fill },
        inactive && [styles.barInactive, { borderColor: colors.border ?? undefined }],
        style,
      ]}
    >
      <Text style={[styles.barTitle, { color: colors.text }]} numberOfLines={1}>
        {continuesBefore ? '… ' : ''}
        <Text style={inactive && styles.struck}>{title}</Text>
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  block: {
    position: 'absolute',
    borderWidth: 1,
    paddingHorizontal: 3,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  outline: { ...StyleSheet.absoluteFillObject, borderWidth: 1 },
  blockTitle: { fontSize: 12, lineHeight: 15, fontWeight: '500' },
  blockTime: { fontSize: 10.5, lineHeight: 13, fontWeight: '400', opacity: 0.85 },
  struck: { textDecorationLine: 'line-through' },
  bar: {
    position: 'absolute',
    paddingHorizontal: 4,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  // The outline takes the place of a pixel of padding.
  barInactive: { borderWidth: 1, paddingHorizontal: 3 },
  barTitle: { fontSize: 12, lineHeight: 15, fontWeight: '500' },
});
