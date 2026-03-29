import React from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react-native';
import { format, startOfMonth, endOfMonth, startOfWeek, endOfWeek, addDays, isSameMonth, isToday, addMonths, subMonths } from 'date-fns';
import { colors } from '../theme/colors';

const MOCK_EVENTS = [
  { id: '1', title: 'Team Standup', time: '09:00', color: '#3b82f6' },
  { id: '2', title: 'Design Review', time: '11:00', color: '#8b5cf6' },
  { id: '3', title: 'Lunch with Sarah', time: '12:30', color: '#22c55e' },
  { id: '4', title: 'Sprint Planning', time: '14:00', color: '#f59e0b' },
];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function MonthGrid({ currentDate }: { currentDate: Date }) {
  const monthStart = startOfMonth(currentDate);
  const monthEnd = endOfMonth(currentDate);
  const calStart = startOfWeek(monthStart);
  const calEnd = endOfWeek(monthEnd);

  const days: Date[] = [];
  let day = calStart;
  while (day <= calEnd) {
    days.push(day);
    day = addDays(day, 1);
  }

  return (
    <View>
      <View style={styles.weekdayRow}>
        {WEEKDAYS.map((wd) => (
          <Text key={wd} style={styles.weekdayLabel}>{wd}</Text>
        ))}
      </View>
      <View style={styles.daysGrid}>
        {days.map((d, i) => {
          const sameMonth = isSameMonth(d, currentDate);
          const today = isToday(d);
          return (
            <View key={i} style={styles.dayCell}>
              <View style={[styles.dayNumber, today && styles.todayCircle]}>
                <Text style={[
                  styles.dayText,
                  !sameMonth && styles.dayTextMuted,
                  today && styles.todayText,
                ]}>
                  {format(d, 'd')}
                </Text>
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

export default function CalendarScreen() {
  const [currentDate, setCurrentDate] = React.useState(new Date());

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <CalendarDays size={24} color={colors.primary} />
        <Text style={styles.headerTitle}>Calendar</Text>
      </View>

      <View style={styles.monthNav}>
        <Pressable onPress={() => setCurrentDate(subMonths(currentDate, 1))} style={styles.navBtn}>
          <ChevronLeft size={20} color={colors.text} />
        </Pressable>
        <Text style={styles.monthLabel}>{format(currentDate, 'MMMM yyyy')}</Text>
        <Pressable onPress={() => setCurrentDate(addMonths(currentDate, 1))} style={styles.navBtn}>
          <ChevronRight size={20} color={colors.text} />
        </Pressable>
      </View>

      <MonthGrid currentDate={currentDate} />

      <View style={styles.todaySection}>
        <Text style={styles.todaySectionTitle}>Today's Events</Text>
        {MOCK_EVENTS.map((event) => (
          <Pressable key={event.id} style={styles.eventCard}>
            <View style={[styles.eventDot, { backgroundColor: event.color }]} />
            <View style={styles.eventContent}>
              <Text style={styles.eventTitle}>{event.title}</Text>
              <Text style={styles.eventTime}>{event.time}</Text>
            </View>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 8,
  },
  headerTitle: { fontSize: 20, fontWeight: '700', color: colors.text },
  monthNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  navBtn: { padding: 8 },
  monthLabel: { fontSize: 17, fontWeight: '600', color: colors.text },
  weekdayRow: {
    flexDirection: 'row',
    paddingHorizontal: 8,
    marginBottom: 4,
  },
  weekdayLabel: {
    flex: 1,
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '600',
    color: colors.textMuted,
  },
  daysGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 8,
  },
  dayCell: {
    width: '14.28%',
    alignItems: 'center',
    paddingVertical: 6,
  },
  dayNumber: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayText: { fontSize: 14, color: colors.text },
  dayTextMuted: { color: colors.textMuted },
  todayCircle: { backgroundColor: colors.primary },
  todayText: { color: colors.textInverse, fontWeight: '700' },
  todaySection: { paddingHorizontal: 16, paddingTop: 20 },
  todaySectionTitle: { fontSize: 16, fontWeight: '600', color: colors.text, marginBottom: 12 },
  eventCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
  },
  eventDot: { width: 10, height: 10, borderRadius: 5, marginRight: 12 },
  eventContent: { flex: 1 },
  eventTitle: { fontSize: 15, fontWeight: '500', color: colors.text },
  eventTime: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
});
