import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Clock, MapPin, Users } from 'lucide-react-native';
import { format } from 'date-fns';
import type { Calendar, CalendarEvent } from '../../api/types';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import {
  eventTimeRange,
  getEventColor,
  isTimedEventFullDayOnDate,
  timePattern,
  type TimeFormat,
} from '../../lib/calendar-utils';
import { useCalendarLocale } from '../../lib/calendar-locale';
import { isInactiveEvent } from '../../lib/calendar-participants';

interface EventCardProps {
  event: CalendarEvent;
  calendars: Calendar[];
  timeFormat?: TimeFormat;
  /** The user's addresses, to draw events they declined as inactive. */
  currentUserEmails?: string[];
  onPress?: (event: CalendarEvent) => void;
  onLongPress?: (event: CalendarEvent) => void;
  /** The day the row is listed under: a timed event filling it reads as all day. */
  day?: Date;
}

function participantCount(event: CalendarEvent): number {
  return event.participants ? Object.keys(event.participants).length : 0;
}

/**
 * An event as an agenda row (repos/branding/APP.md): a dot in the calendar
 * colour before the title, no card and no bar. Declined and cancelled events
 * get a hollow dot and a struck-through, muted title.
 */
export function EventCard({ event, calendars, timeFormat, currentUserEmails, onPress, onLongPress, day }: EventCardProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const { locale, t } = useCalendarLocale();
  const color = getEventColor(event, calendars);
  const range = eventTimeRange(event);
  const { start, end } = range;
  const allDay = range.allDay || (!!day && isTimedEventFullDayOnDate(event, day));
  const fmt = timePattern(timeFormat);
  const time = allDay
    ? t('calendar.events.all_day', 'All day')
    : `${format(start, fmt, { locale })} – ${format(end, fmt, { locale })}`;
  const count = participantCount(event);
  const location = event.locations ? Object.values(event.locations)[0]?.name : undefined;
  const inactive = isInactiveEvent(event, currentUserEmails);

  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={() => onPress?.(event)}
      onLongPress={() => onLongPress?.(event)}
    >
      <View style={[styles.dot, inactive ? [styles.dotHollow, { borderColor: color }] : { backgroundColor: color }]} />
      <View style={styles.body}>
        <View style={styles.headerRow}>
          <Text style={[styles.title, inactive && styles.titleInactive]} numberOfLines={1}>
            {event.title || t('calendar.events.no_title', '(No title)')}
          </Text>
          {allDay && (
            <View style={styles.allDayBadge}>
              <Text style={styles.allDayText}>{t('calendar.events.all_day', 'All day')}</Text>
            </View>
          )}
          {event.status === 'tentative' && (
            <View style={styles.allDayBadge}>
              <Text style={styles.allDayText}>{t('calendar.detail.tentative', 'Tentative')}</Text>
            </View>
          )}
        </View>
        {!allDay && (
          <View style={styles.detailRow}>
            <Clock size={12} color={c.textMuted} />
            <Text style={styles.detailText}>{time}</Text>
          </View>
        )}
        {location ? (
          <View style={styles.detailRow}>
            <MapPin size={12} color={c.textMuted} />
            <Text style={styles.detailText} numberOfLines={1}>
              {location}
            </Text>
          </View>
        ) : null}
        {count > 0 && (
          <View style={styles.detailRow}>
            <Users size={12} color={c.textMuted} />
            <Text style={styles.detailText}>
              {t('calendar.participants.count', '{count, plural, one {# participant} other {# participants}}', { count })}
            </Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

const EVENT_DOT = 9;

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  // Bleeds into the list's side padding so the dot lines up with the day
  // headers while the pressed highlight keeps some room around the text.
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    marginHorizontal: -spacing.sm,
    borderRadius: radius.sm,
  },
  rowPressed: { backgroundColor: c.surfaceHover },
  // Centred on the title's line (bodyMedium, 20px).
  dot: {
    width: EVENT_DOT,
    height: EVENT_DOT,
    borderRadius: EVENT_DOT / 2,
    marginTop: (typography.bodyMedium.lineHeight - EVENT_DOT) / 2,
  },
  dotHollow: { borderWidth: 1.5 },
  body: { flex: 1, gap: 4 },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  title: { ...typography.bodyMedium, color: c.text, flex: 1 },
  titleInactive: { textDecorationLine: 'line-through', color: c.mutedForeground },
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
