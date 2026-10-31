// Port of webmail components/email/structured-mail/booking-calendar-actions.tsx
// at 3aac5a5c4, on React Native views. App: the calendar picker opens as a
// list under the button (CalendarInvitationBanner's picker) instead of a
// floating menu, and "View in calendar" opens the event on the Calendar tab.
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { Email } from '../../../api/types';
import { getCalendarColor } from '../../../lib/calendar-utils';
import type { StructuredCard } from '../../../lib/structured-mail';
import type { RootStackParamList } from '../../../navigation/types';
import { useLocaleStore } from '../../../stores/locale-store';
import { useColors, useCvdColor } from '../../../theme/colors';
import { radius, spacing, typography, type ThemePalette } from '../../../theme/tokens';
import { ArrowRight, CalendarCheck, CalendarDays, CalendarPlus, CalendarX, ChevronDown } from '../../icons';
import { useBookingCalendar } from './use-booking-calendar';

type Nav = NativeStackNavigationProp<RootStackParamList>;

/**
 * The calendar part of a booking card's action row: "Add to calendar" (with
 * a calendar picker when there is more than one calendar to choose from),
 * "Update in calendar", "Remove from calendar", the "In your calendar" pill
 * and "View in calendar". Renders nothing when the booking has no calendar
 * action (see useBookingCalendar).
 */
export function BookingCalendarActions({ booking, email }: { booking: StructuredCard; email: Pick<Email, 'from' | 'subject'> }) {
  const c = useColors();
  const paint = useCvdColor();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const navigation = useNavigation<Nav>();
  const openCalendar = React.useCallback(() => {
    navigation.navigate('MainTabs', { screen: 'Calendar' } as never);
  }, [navigation]);
  const calendar = useBookingCalendar(booking, email, { openCalendar });
  const { status, calendars, busy, error, notice } = calendar;
  const [pickerOpen, setPickerOpen] = React.useState(false);

  if (status === 'hidden' || status === 'loading') return null;
  // A cancelled booking with nothing in the calendar has no action; only the
  // confirmation of a removal just done stays.
  if (status === 'cancelled' && notice !== 'removed') return null;

  const onAdd = () => {
    if (calendars.length <= 1) {
      void calendar.add(calendars[0]?.id);
      return;
    }
    setPickerOpen((open) => !open);
  };

  const noticeText = notice === 'added'
    ? t('structured_mail_calendar.added', 'Added to your calendar')
    : notice === 'updated'
      ? t('structured_mail_calendar.updated', 'Calendar updated')
      : notice === 'removed'
        ? t('structured_mail_calendar.removed', 'Removed from your calendar')
        : null;
  const showView = status === 'in-calendar' || status === 'update';

  return (
    <View style={styles.row} testID="booking-calendar-actions">
      {status === 'add' ? (
        <Pressable
          onPress={onAdd}
          disabled={busy}
          style={({ pressed }) => [styles.button, pressed && styles.pressed, busy && styles.disabled]}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy, expanded: calendars.length > 1 ? pickerOpen : undefined }}
          testID="booking-calendar-add"
        >
          <CalendarPlus size={14} color={c.textSecondary} />
          <Text style={styles.buttonText}>{t('structured_mail_calendar.add_to_calendar', 'Add to calendar')}</Text>
          {calendars.length > 1 ? <ChevronDown size={12} color={c.textSecondary} /> : null}
        </Pressable>
      ) : null}

      {status === 'update' ? (
        <Pressable
          onPress={() => { void calendar.update(); }}
          disabled={busy}
          style={({ pressed }) => [styles.button, pressed && styles.pressed, busy && styles.disabled]}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          testID="booking-calendar-update"
        >
          <CalendarCheck size={14} color={c.textSecondary} />
          <Text style={styles.buttonText}>{t('structured_mail_calendar.update_in_calendar', 'Update in calendar')}</Text>
        </Pressable>
      ) : null}

      {status === 'remove' ? (
        <Pressable
          onPress={() => { void calendar.remove(); }}
          disabled={busy}
          style={({ pressed }) => [styles.button, pressed && styles.pressedDestructive, busy && styles.disabled]}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          testID="booking-calendar-remove"
        >
          <CalendarX size={14} color={c.textSecondary} />
          <Text style={styles.buttonText}>{t('structured_mail_calendar.remove_from_calendar', 'Remove from calendar')}</Text>
        </Pressable>
      ) : null}

      {status === 'in-calendar' && !noticeText ? (
        <View style={styles.pill}><Text style={styles.pillText}>{t('structured_mail_calendar.in_calendar', 'In your calendar')}</Text></View>
      ) : null}

      {noticeText ? (
        <View style={styles.pill} accessibilityLiveRegion="polite" testID="booking-calendar-notice">
          <Text style={styles.pillText}>{noticeText}</Text>
        </View>
      ) : null}

      {showView ? (
        <Pressable
          onPress={calendar.viewInCalendar}
          style={({ pressed }) => [styles.link, pressed && styles.pressed]}
          accessibilityRole="button"
          testID="booking-calendar-view"
        >
          <CalendarDays size={14} color={c.textSecondary} />
          <Text style={styles.buttonText}>{t('structured_mail_calendar.view_in_calendar', 'View in calendar')}</Text>
          <ArrowRight size={12} color={c.textSecondary} />
        </Pressable>
      ) : null}

      {busy ? <ActivityIndicator size="small" color={c.textMuted} /> : null}

      {status === 'add' && pickerOpen && calendars.length > 1 ? (
        <View style={styles.picker} accessibilityLabel={t('structured_mail_calendar.select_calendar', 'Choose a calendar')} testID="booking-calendar-picker">
          <Text style={styles.pickerTitle}>{t('structured_mail_calendar.select_calendar', 'Choose a calendar')}</Text>
          {calendars.map((cal) => (
            <Pressable
              key={cal.id}
              onPress={() => {
                setPickerOpen(false);
                void calendar.add(cal.id);
              }}
              style={({ pressed }) => [styles.pickerRow, pressed && styles.pressed]}
              accessibilityRole="menuitem"
              accessibilityLabel={cal.name}
              testID="booking-calendar-choice"
            >
              <View style={[styles.swatch, { backgroundColor: paint(getCalendarColor(cal)) }]} />
              <Text style={styles.pickerText} numberOfLines={1}>{cal.name}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {error ? (
        <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="assertive" testID="booking-calendar-error">{error}</Text>
      ) : null}
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
    button: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      minHeight: 36,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.background,
    },
    link: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: spacing.md, borderRadius: radius.md },
    pressed: { backgroundColor: c.surfaceHover },
    pressedDestructive: { backgroundColor: c.errorBg, borderColor: c.errorBorder },
    disabled: { opacity: 0.5 },
    buttonText: { ...typography.body, color: c.textSecondary },
    pill: { borderRadius: radius.full, paddingHorizontal: 8, paddingVertical: 2, backgroundColor: c.successBg },
    pillText: { ...typography.small, color: c.success },
    picker: {
      flexBasis: '100%',
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      backgroundColor: c.background,
      overflow: 'hidden',
    },
    pickerTitle: { ...typography.captionMedium, color: c.textMuted, paddingHorizontal: spacing.md, paddingVertical: 6 },
    pickerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 40, paddingHorizontal: spacing.md },
    pickerText: { ...typography.body, color: c.text, flex: 1 },
    swatch: { width: 12, height: 12, borderRadius: 6 },
    error: { ...typography.caption, color: c.error, flexBasis: '100%' },
  });
}
