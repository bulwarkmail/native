import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { CalendarEvent } from '../../api/types';
import type { EventBlockColors } from '../../lib/event-colors';
import { isTaskDone, isTaskEvent, taskIdOfEvent } from '../../lib/calendar-tasks';
import { useColors } from '../../theme/colors';
import { CHROME_MAX_FONT_SCALE, fontPx } from '../../theme/tokens';

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

/** A task item's completion circle (webmail's CalendarTaskChip). */
export interface TaskControl {
  done: boolean;
  /** Accessibility label: "Mark as done" or "Mark as not done". */
  label: string;
  onToggle: () => void;
}

/** The completion control for a task item on the grid; undefined for an event. */
export function taskControlFor(
  event: CalendarEvent,
  onToggleTask: ((taskId: string) => void) | undefined,
  t: (key: string, fallback: string) => string,
): TaskControl | undefined {
  if (!isTaskEvent(event)) return undefined;
  const done = isTaskDone(event);
  return {
    done,
    label: done
      ? t('calendar.tasks.mark_incomplete', 'Mark as not done')
      : t('calendar.tasks.mark_complete', 'Mark as done'),
    onToggle: () => onToggleTask?.(taskIdOfEvent(event)),
  };
}

/**
 * The circle at the start of a task: tapping it toggles done, without
 * opening the task. Hollow while open, filled once done.
 */
export function TaskCircle({ task, color, size = 11 }: { task: TaskControl; color: string; size?: number }) {
  const styles = useStyles();
  return (
    <Pressable
      onPress={task.onToggle}
      hitSlop={6}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: task.done }}
      accessibilityLabel={task.label}
      style={styles.taskCircleHit}
    >
      <View
        style={[
          { width: size, height: size, borderRadius: size / 2, borderWidth: 1, borderColor: color },
          task.done && { backgroundColor: color },
        ]}
      />
    </Pressable>
  );
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
  /** Set for a task: draws its completion circle. */
  task?: TaskControl;
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
  task,
  onPress,
}: TimedEventBlockProps) {
  const styles = useStyles();
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
      <View style={styles.taskRow}>
        {task && <TaskCircle task={task} color={colors.text} />}
        <Text
          style={[styles.blockTitle, styles.taskTitle, { color: colors.text }, inactive && styles.struck]}
          numberOfLines={1}
          maxFontSizeMultiplier={CHROME_MAX_FONT_SCALE}
        >
          {title}
        </Text>
      </View>
      {timeLabel !== null && (
        <Text style={[styles.blockTime, { color: colors.text }]} numberOfLines={1} maxFontSizeMultiplier={CHROME_MAX_FONT_SCALE}>
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
  /** Set for a task: draws its completion circle. */
  task?: TaskControl;
  onPress?: () => void;
}

/** An all-day or multi-day event in the strip above the grid. */
export function AllDayEventBar({
  title,
  colors,
  continuesBefore,
  continuesAfter,
  style,
  task,
  onPress,
}: AllDayEventBarProps) {
  const styles = useStyles();
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
      <View style={styles.taskRow}>
        {task && <TaskCircle task={task} color={colors.text} />}
        <Text
          style={[styles.barTitle, styles.taskTitle, { color: colors.text }]}
          numberOfLines={1}
          maxFontSizeMultiplier={CHROME_MAX_FONT_SCALE}
        >
          {continuesBefore ? '… ' : ''}
          <Text style={inactive && styles.struck}>{title}</Text>
        </Text>
      </View>
    </Pressable>
  );
}

// Text sizes follow the font size setting, and useColors() changes identity
// with it, so the styles rebuild then. The boxes are fixed, so their Text caps
// the OS font scale at CHROME_MAX_FONT_SCALE.
function useStyles() {
  const c = useColors();
  return useMemo(makeStyles, [c]);
}

const makeStyles = () => StyleSheet.create({
  block: {
    position: 'absolute',
    borderWidth: 1,
    paddingHorizontal: 3,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  outline: { ...StyleSheet.absoluteFillObject, borderWidth: 1 },
  blockTitle: { fontSize: fontPx(12), lineHeight: fontPx(15), fontWeight: '500' },
  blockTime: { fontSize: fontPx(10.5), lineHeight: fontPx(13), fontWeight: '400', opacity: 0.85 },
  struck: { textDecorationLine: 'line-through' },
  taskRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  taskTitle: { flexShrink: 1 },
  taskCircleHit: { justifyContent: 'center' },
  bar: {
    position: 'absolute',
    paddingHorizontal: 4,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  // The outline takes the place of a pixel of padding.
  barInactive: { borderWidth: 1, paddingHorizontal: 3 },
  barTitle: { fontSize: fontPx(12), lineHeight: fontPx(15), fontWeight: '500' },
});
