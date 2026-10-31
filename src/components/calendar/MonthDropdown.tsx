import React from 'react';
import {
  FlatList,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import type { Calendar } from '../../api/types';
import type { ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import type { EventDayIndex } from '../../lib/calendar-utils';
import { useCalendarLocale } from '../../lib/calendar-locale';
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
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const { system } = useCalendarLocale();
  // Pages are as wide as the panel (the window, or a pane on a tablet) and
  // re-measure on rotation. In a short window the panel takes at most about
  // half of it and its month scrolls inside.
  const [measuredWidth, setMeasuredWidth] = React.useState(0);
  const width = measuredWidth || windowWidth;
  const panelHeight = Math.min(PANEL_HEIGHT, Math.round(windowHeight * 0.55));
  // The months are fixed while the panel is open; it remounts on each open.
  // Jalali months for Persian, as the month grid shows them.
  const [months] = React.useState(() => {
    const first = system.addMonths(system.startOfMonth(month), -MONTHS_EACH_SIDE);
    return Array.from({ length: MONTHS_EACH_SIDE * 2 + 1 }, (_, i) => system.addMonths(first, i));
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
      <ScrollView
        style={{ width, height: panelHeight }}
        scrollEnabled={panelHeight < PANEL_HEIGHT}
        showsVerticalScrollIndicator={false}
      >
        <MonthView
          currentDate={item}
          selectedDate={selectedDate}
          events={[]}
          eventsByDay={eventsByDay}
          calendars={calendars}
          weekStartsOn={weekStartsOn}
          onSelectDate={onSelectDate}
        />
      </ScrollView>
    ),
    [width, panelHeight, selectedDate, eventsByDay, calendars, weekStartsOn, onSelectDate],
  );

  const getItemLayout = React.useCallback(
    (_: ArrayLike<Date> | null | undefined, i: number) => ({ length: width, offset: width * i, index: i }),
    [width],
  );

  return (
    <View
      style={styles.panel}
      onLayout={(e) => {
        const w = Math.round(e.nativeEvent.layout.width);
        if (w > 0 && w !== measuredWidth) setMeasuredWidth(w);
      }}
    >
      <FlatList
        // A new width remounts the pager on the month it was showing.
        key={width}
        horizontal
        pagingEnabled
        data={months}
        keyExtractor={monthKey}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        initialScrollIndex={lastIndexRef.current}
        onMomentumScrollEnd={handleMomentumEnd}
        showsHorizontalScrollIndicator={false}
        initialNumToRender={1}
        windowSize={3}
        style={{ height: panelHeight }}
      />
    </View>
  );
}

function monthKey(month: Date): string {
  return month.toISOString();
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
