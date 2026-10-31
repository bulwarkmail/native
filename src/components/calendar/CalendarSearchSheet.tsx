import React from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { format } from 'date-fns';
import { ArrowLeft, MapPin, Repeat, Search, X } from '../icons';
import type { Calendar, CalendarEvent } from '../../api/types';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useCalendarStore, searchCalendarEvents } from '../../stores/calendar-store';
import { useCalendarLocale } from '../../lib/calendar-locale';
import { formatCalendarDay } from '../../lib/calendar-system';
import { displayNow } from '../../lib/calendar-timezone';
import { eventMatches, orderSearchResults, searchTerms } from '../../lib/calendar-search';
import {
  getEventColor,
  getEventEndDate,
  getEventStartDate,
  getPrimaryCalendarId,
  timePattern,
  type TimeFormat,
} from '../../lib/calendar-utils';
import { isInactiveEvent } from '../../lib/calendar-participants';
import { SafeAreaModal } from '../SafeAreaModal';
import { MODAL_ORIENTATIONS } from '../../lib/modal-orientations';

const DEBOUNCE_MS = 250;

interface CalendarSearchSheetProps {
  visible: boolean;
  calendars: Calendar[];
  timeFormat?: TimeFormat;
  currentUserEmails?: string[];
  /** Called once the search is closed. */
  onSelectEvent: (event: CalendarEvent) => void;
  onClose: () => void;
}

type Row =
  | { kind: 'header'; key: string; label: string }
  | { kind: 'event'; key: string; event: CalendarEvent };

/**
 * Search the events by title, place, description and participants (webmail
 * calendar-search). The loaded events answer at once; the server's text
 * search adds the rest of the calendar, whatever the date.
 */
export function CalendarSearchSheet({
  visible,
  calendars,
  timeFormat,
  currentUserEmails = [],
  onSelectEvent,
  onClose,
}: CalendarSearchSheetProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const { locale, t, system } = useCalendarLocale();
  const loaded = useCalendarStore((s) => s.events);
  const [query, setQuery] = React.useState('');
  const [remote, setRemote] = React.useState<{ query: string; events: CalendarEvent[] } | null>(null);

  React.useEffect(() => {
    if (!visible) {
      setQuery('');
      setRemote(null);
    }
  }, [visible]);

  const terms = React.useMemo(() => searchTerms(query), [query]);
  const key = terms.join(' ');
  React.useEffect(() => {
    if (!visible || terms.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      searchCalendarEvents(terms)
        .then((events) => { if (!cancelled) setRemote({ query: key, events }); })
        // A server that can't search leaves the loaded matches.
        .catch(() => { if (!cancelled) setRemote({ query: key, events: [] }); });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, key]);

  // iOS can't present the detail sheet while this one is still going away:
  // the event opens once it is gone (onDismiss, iOS only).
  const pending = React.useRef<CalendarEvent | null>(null);
  const choose = (event: CalendarEvent) => {
    if (Platform.OS === 'ios') {
      pending.current = event;
      onClose();
      return;
    }
    onClose();
    onSelectEvent(event);
  };

  const answered = remote?.query === key ? remote.events : null;
  const searching = terms.length > 0 && !answered;
  const results = React.useMemo(() => {
    if (terms.length === 0) return null;
    const local = loaded.filter((e) => eventMatches(e, terms));
    return orderSearchResults(local, answered ?? [], displayNow().getTime());
  }, [loaded, terms, answered]);

  const rows = React.useMemo<Row[]>(() => {
    if (!results) return [];
    const out: Row[] = [];
    if (results.upcoming.length > 0) {
      out.push({ kind: 'header', key: 'h-upcoming', label: t('calendar.search.upcoming', 'Upcoming') });
      for (const event of results.upcoming) out.push({ kind: 'event', key: `u-${event.id}`, event });
    }
    if (results.past.length > 0) {
      out.push({ kind: 'header', key: 'h-past', label: t('calendar.search.past', 'Past') });
      for (const event of results.past) out.push({ kind: 'event', key: `p-${event.id}`, event });
    }
    return out;
  }, [results, t]);

  const time = timePattern(timeFormat);
  const thisYear = displayNow().getFullYear();
  const renderEvent = (event: CalendarEvent) => {
    const start = getEventStartDate(event);
    const end = getEventEndDate(event);
    const calendar = calendars.find((cal) => cal.id === getPrimaryCalendarId(event));
    const color = getEventColor(event, calendars);
    const inactive = isInactiveEvent(event, currentUserEmails);
    const place = event.locations ? Object.values(event.locations)[0]?.name : undefined;
    const meta = [place, calendar?.name].filter(Boolean).join(' · ');
    // A series the server found by its stored event.
    const repeats = !event.recurrenceId && !!event.recurrenceRules?.length;
    const title = event.title || t('calendar.events.no_title', '(No title)');
    return (
      <Pressable
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        onPress={() => choose(event)}
        accessibilityRole="button"
        accessibilityLabel={title}
      >
        <View style={styles.when}>
          <Text style={styles.whenDay}>
            {system.jalali
              ? formatCalendarDay(start, locale, system.year(start) === system.year(new Date()) ? 'weekdayMonthDay' : 'monthDayYear')
              : format(start, start.getFullYear() === thisYear ? 'EEE, MMM d' : 'MMM d, yyyy', { locale })}
          </Text>
          <Text style={styles.whenTime}>
            {event.showWithoutTime
              ? t('calendar.events.all_day', 'All day')
              : `${format(start, time, { locale })} – ${format(end, time, { locale })}`}
          </Text>
        </View>
        <View style={[styles.dot, inactive ? { borderWidth: 1.5, borderColor: color } : { backgroundColor: color }]} />
        <View style={styles.what}>
          <Text style={[styles.title, inactive && styles.inactive]} numberOfLines={1}>{title}</Text>
          {(meta || repeats) ? (
            <View style={styles.metaRow}>
              {place ? <MapPin size={12} color={c.textMuted} /> : null}
              {meta ? <Text style={styles.meta} numberOfLines={1}>{meta}</Text> : null}
              {repeats && (
                <>
                  <Repeat size={12} color={c.textMuted} />
                  <Text style={styles.meta}>{t('calendar.search.repeats', 'Repeats')}</Text>
                </>
              )}
            </View>
          ) : null}
        </View>
      </Pressable>
    );
  };

  return (
    <SafeAreaModal
      supportedOrientations={MODAL_ORIENTATIONS}
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
      onDismiss={() => {
        const event = pending.current;
        pending.current = null;
        if (event) onSelectEvent(event);
      }}
    >
      <SafeAreaView style={styles.container} edges={['top', 'bottom', 'left', 'right']}>
        <View style={styles.header}>
          <Pressable
            onPress={onClose}
            hitSlop={8}
            style={styles.headerBtn}
            accessibilityRole="button"
            accessibilityLabel={t('calendar.search.close', 'Close search')}
          >
            <ArrowLeft size={20} color={c.text} />
          </Pressable>
          <View style={styles.field}>
            <Search size={16} color={c.textMuted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t('calendar.search.title', 'Search events')}
              placeholderTextColor={c.mutedForeground}
              style={styles.input}
              autoFocus
              autoCorrect={false}
              returnKeyType="search"
              accessibilityLabel={t('calendar.search.title', 'Search events')}
            />
            {query ? (
              <Pressable
                onPress={() => setQuery('')}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('calendar.search.clear', 'Clear search')}
              >
                <X size={16} color={c.textMuted} />
              </Pressable>
            ) : null}
          </View>
        </View>

        {searching && rows.length === 0 ? (
          <View style={styles.center}><ActivityIndicator color={c.primary} /></View>
        ) : results && rows.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>
              {t('calendar.search.no_results', 'No events match “{query}”', { query: query.trim() })}
            </Text>
            <Text style={styles.emptyHint}>
              {t('calendar.search.no_results_hint', 'Search looks at titles, places, descriptions and guests.')}
            </Text>
          </View>
        ) : (
          <FlatList
            data={rows}
            keyExtractor={(row) => row.key}
            keyboardShouldPersistTaps="handled"
            automaticallyAdjustKeyboardInsets
            ListHeaderComponent={searching ? <ActivityIndicator style={styles.more} color={c.primary} /> : null}
            renderItem={({ item }) => (item.kind === 'header'
              ? <Text style={styles.section}>{item.label}</Text>
              : renderEvent(item.event))}
          />
        )}
      </SafeAreaView>
    </SafeAreaModal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    headerBtn: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
    field: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      minHeight: 40,
      paddingHorizontal: spacing.md,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    input: { flex: 1, ...typography.body, color: c.text, paddingVertical: spacing.sm },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm },
    emptyTitle: { ...typography.bodyMedium, color: c.text, textAlign: 'center' },
    emptyHint: { ...typography.caption, color: c.textMuted, textAlign: 'center' },
    more: { paddingVertical: spacing.sm },
    section: {
      ...typography.captionMedium,
      color: c.textSecondary,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.lg,
      paddingBottom: spacing.xs,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    rowPressed: { backgroundColor: c.surface },
    when: { width: 104 },
    whenDay: { ...typography.body, color: c.text },
    whenTime: { ...typography.caption, color: c.textMuted },
    dot: { width: 9, height: 9, borderRadius: 5, marginTop: 6 },
    what: { flex: 1, minWidth: 0 },
    title: { ...typography.bodyMedium, color: c.text },
    inactive: { textDecorationLine: 'line-through', color: c.textMuted },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: 2 },
    meta: { ...typography.caption, color: c.textMuted, flexShrink: 1 },
  });
}
