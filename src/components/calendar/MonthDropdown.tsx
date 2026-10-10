import React from 'react';
import {
  FlatList,
  StyleSheet,
  View,
  useWindowDimensions,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { addMonths, startOfMonth } from 'date-fns';
import type { Calendar } from '../../api/types';
import type { ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import type { EventDayIndex } from '../../lib/calendar-utils';
import { MONTH_ROW_HEIGHT, MonthView } from './MonthView';

type WeekStart = 0 | 1 | 6;

/** Months either side of the one the panel opens on. */
const MONTHS_EACH_SIDE = 24;
/** Six week rows plus the weekday initials. */
const PANEL_HEIGHT = MONTH_ROW_HEIGHT * 6 + 22;

interface MonthDropdownProps {
  /** The month the panel opens on. */
  month: Date;
  selectedDate: Date;
  eventsByDay: EventDayIndex;
  calendars: Calendar[];
  weekStartsOn: WeekStart;
  /** Reports the month swiped to, so the title can follow it. */
  onMonthChange: (month: Date) => void;
  onSelectDate: (date: Date) => void;
}

/**
 * The month that drops down under the calendar title: swipe sideways
 * between months, tap a day to go there.
 */
export function MonthDropdown({
  month,
  selectedDate,
  eventsByDay,
  calendars,
  weekStartsOn,
  onMonthChange,
  onSelectDate,
}: MonthDropdownProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const { width } = useWindowDimensions();
  // The months are fixed while the panel is open; it remounts on each open.
  const [months] = React.useState(() => {
    const first = addMonths(startOfMonth(month), -MONTHS_EACH_SIDE);
    return Array.from({ length: MONTHS_EACH_SIDE * 2 + 1 }, (_, i) => addMonths(first, i));
  });
  const lastIndexRef = React.useRef(MONTHS_EACH_SIDE);

  const handleMomentumEnd = React.useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const index = Math.round(e.nativeEvent.contentOffset.x / width);
      if (index === lastIndexRef.current || !months[index]) return;
      lastIndexRef.current = index;
      onMonthChange(months[index]);
    },
    [width, months, onMonthChange],
  );

  const renderItem = React.useCallback(
    ({ item }: ListRenderItemInfo<Date>) => (
      <View style={{ width, height: PANEL_HEIGHT }}>
        <MonthView
          currentDate={item}
          selectedDate={selectedDate}
          events={[]}
          eventsByDay={eventsByDay}
          calendars={calendars}
          weekStartsOn={weekStartsOn}
          onSelectDate={onSelectDate}
        />
      </View>
    ),
    [width, selectedDate, eventsByDay, calendars, weekStartsOn, onSelectDate],
  );

  const getItemLayout = React.useCallback(
    (_: ArrayLike<Date> | null | undefined, i: number) => ({ length: width, offset: width * i, index: i }),
    [width],
  );

  return (
    <View style={styles.panel}>
      <FlatList
        horizontal
        pagingEnabled
        data={months}
        keyExtractor={monthKey}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        initialScrollIndex={MONTHS_EACH_SIDE}
        onMomentumScrollEnd={handleMomentumEnd}
        showsHorizontalScrollIndicator={false}
        initialNumToRender={1}
        windowSize={3}
        style={{ height: PANEL_HEIGHT }}
      />
    </View>
  );
}

function monthKey(month: Date): string {
  return `${month.getFullYear()}-${month.getMonth()}`;
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    panel: {
      backgroundColor: c.background,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      paddingTop: 4,
    },
  });
}
