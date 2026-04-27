import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Clock, MapPin, Users } from 'lucide-react-native';
import { format } from 'date-fns';
import type { Calendar, CalendarEvent } from '../../api/types';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { eventTimeRange, getEventColor } from '../../lib/calendar-utils';

interface EventCardProps {
  event: CalendarEvent;
  calendars: Calendar[];
  onPress?: (event: CalendarEvent) => void;
  onLongPress?: (event: CalendarEvent) => void;
}

function participantCount(event: CalendarEvent): number {
  return event.participants ? Object.keys(event.participants).length : 0;
}

function formatTimeRange(event: CalendarEvent): string {
  const { start, end, allDay } = eventTimeRange(event);
  if (allDay) return 'All day';
  return `${format(start, 'HH:mm')} – ${format(end, 'HH:mm')}`;
}

export function EventCard({ event, calendars, onPress, onLongPress }: EventCardProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const color = getEventColor(event, calendars);
  const time = formatTimeRange(event);
  const count = participantCount(event);

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={() => onPress?.(event)}
      onLongPress={() => onLongPress?.(event)}
    >
      <View style={[styles.colorBar, { backgroundColor: color }]} />
      <View style={styles.body}>
        <View style={styles.headerRow}>
          <Text style={styles.title} numberOfLines={1}>
            {event.title || 'Untitled'}
          </Text>
          {event.showWithoutTime && (
            <View style={styles.allDayBadge}>
              <Text style={styles.allDayText}>All day</Text>
            </View>
          )}
        </View>
        {!event.showWithoutTime && (
          <View style={styles.detailRow}>
            <Clock size={12} color={c.textMuted} />
            <Text style={styles.detailText}>{time}</Text>
          </View>
        )}
        {event.description ? (
          <View style={styles.detailRow}>
            <MapPin size={12} color={c.textMuted} />
            <Text style={styles.detailText} numberOfLines={1}>
              {event.description}
            </Text>
          </View>
        ) : null}
        {count > 0 && (
          <View style={styles.detailRow}>
            <Users size={12} color={c.textMuted} />
            <Text style={styles.detailText}>{count} participants</Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  card: {
    flexDirection: 'row',
    backgroundColor: c.card,
    borderRadius: radius.lg,
    marginBottom: spacing.sm,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: c.border,
  },
  cardPressed: { backgroundColor: c.surfaceHover },
  colorBar: { width: 3 },
  body: { flex: 1, padding: spacing.md, gap: 4 },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  title: { ...typography.bodyMedium, color: c.text, flex: 1 },
  allDayBadge: {
    backgroundColor: c.primaryBg,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  allDayText: { ...typography.small, color: c.primary },
  detailRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  detailText: { ...typography.caption, color: c.textMuted, flexShrink: 1 },
  });
}
