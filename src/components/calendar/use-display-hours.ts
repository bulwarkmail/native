import React from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollView } from 'react-native';
import { useSettingsStore } from '../../stores/settings-store';
import { displayNowMinutes } from '../../lib/calendar-timezone';
import {
  FULL_DAY_HOURS,
  initialScrollY,
  rangeChangeScrollY,
  resolveDisplayHours,
  revealScrollY,
  type DisplayHours,
} from '../../lib/calendar-display-range';

/**
 * The hours a time grid draws (webmail #1164): the configured range, or the
 * whole day while the user has asked to see it. The "show all hours" choice
 * is per view and not saved, like the webmail's. Owns the grid's vertical
 * scroll position too: it opens an hour before now, and keeps the same hours
 * in place when the range changes underneath it. Wire `onScroll` to the
 * vertical ScrollView (with a scrollEventThrottle).
 */
export function useDisplayHours(scrollRef: React.RefObject<ScrollView | null>, hourHeight: number) {
  const limitHours = useSettingsStore((s) => s.calendarLimitHours);
  const startHour = useSettingsStore((s) => s.calendarDayStartHour);
  const endHour = useSettingsStore((s) => s.calendarDayEndHour);
  const configured = React.useMemo(
    () => resolveDisplayHours(limitHours, startHour, endHour),
    [limitHours, startHour, endHour],
  );
  const [showAllHours, setShowAllHours] = React.useState(false);
  const hours: DisplayHours = showAllHours ? FULL_DAY_HOURS : configured;

  const scrollYRef = React.useRef(0);
  const onScroll = React.useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollYRef.current = e.nativeEvent.contentOffset.y;
  }, []);

  const scrollTo = React.useCallback((y: number) => {
    scrollYRef.current = y;
    scrollRef.current?.scrollTo({ y, animated: false });
  }, [scrollRef]);

  // Open an hour before now.
  const initialHoursRef = React.useRef(hours);
  React.useEffect(() => {
    const target = initialScrollY(displayNowMinutes(), initialHoursRef.current, hourHeight);
    const frame = requestAnimationFrame(() => scrollTo(target));
    return () => cancelAnimationFrame(frame);
  }, [hourHeight, scrollTo]);

  // The range's start moved (a setting changed, or the whole day was asked
  // for): keep the hours in view where they are, or go to the revealed event.
  const revealRef = React.useRef<number | null>(null);
  const renderedStartRef = React.useRef(hours.startMinutes);
  React.useLayoutEffect(() => {
    const previous = renderedStartRef.current;
    renderedStartRef.current = hours.startMinutes;
    const reveal = revealRef.current;
    revealRef.current = null;
    let target: number | null = null;
    if (reveal !== null) target = revealScrollY(reveal, hours, hourHeight);
    else if (previous !== hours.startMinutes) {
      target = rangeChangeScrollY(scrollYRef.current, previous, hours.startMinutes, hourHeight);
    }
    if (target === null) return;
    const y = target;
    const frame = requestAnimationFrame(() => scrollTo(y));
    return () => cancelAnimationFrame(frame);
  }, [hours, hourHeight, scrollTo]);

  const toggleAllHours = React.useCallback(() => setShowAllHours((v) => !v), []);
  /** Shows the whole day and scrolls to `minutes` from midnight. */
  const revealMinutes = React.useCallback((minutes: number) => {
    revealRef.current = minutes;
    setShowAllHours(true);
  }, []);

  return {
    hours,
    configured,
    /** Whether a range is configured at all, i.e. the toggle has anything to do. */
    canToggle: configured.restricted,
    showAllHours,
    toggleAllHours,
    revealMinutes,
    onScroll,
  };
}
