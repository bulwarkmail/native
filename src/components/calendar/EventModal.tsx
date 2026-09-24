import React from 'react';
import {
  Modal,
  View,
  Text,
  ScrollView,
  TextInput,
  Pressable,
  StyleSheet,
  Switch,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import DateTimePicker from '@react-native-community/datetimepicker';
import {
  X,
  Calendar as CalendarIcon,
  Clock,
  MapPin,
  Video,
  Repeat,
  Bell,
  Plus,
  Users,
  Trash2,
  AlignLeft,
} from 'lucide-react-native';
import { addHours, addMinutes, format } from 'date-fns';
import type {
  Alert,
  Calendar,
  CalendarEvent,
  EventLocation,
  RecurrenceRule,
  VirtualLocation,
} from '../../api/types';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import {
  buildAllDayDuration,
  getCalendarColor,
  getEventDisplayEndDate,
  getEventEndDate,
  getEventStartDate,
  getPrimaryCalendarId,
  timePattern,
} from '../../lib/calendar-utils';
import { getEffectiveTimeZone } from '../../lib/calendar-timezone';
import { useSettingsStore } from '../../stores/settings-store';
import { canCreateEventsIn } from '../../lib/calendar-editability';
import { useCalendarLocale } from '../../lib/calendar-locale';
import {
  alertsToReminders,
  remindersToAlerts,
  preservedAlerts,
  formatReminder,
  REMINDER_PRESETS,
  REMINDER_UNIT_MINUTES,
  type Reminder,
  type ReminderUnit,
} from '../../lib/calendar-alerts';
import { buildRecurrenceSummary, isSimpleRecurrenceRule } from '../../lib/recurrence';
import {
  buildParticipantMap,
  getParticipantList,
  seedAttendees,
  type Attendee,
} from '../../lib/calendar-participants';
import { Button } from '..';
import { ParticipantInput } from './ParticipantInput';
import { RecurrenceEditor } from './RecurrenceEditor';

type RecurrenceOption = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom';

const RECURRENCE_OPTIONS: { value: RecurrenceOption; key: string; fallback: string }[] = [
  { value: 'none', key: 'calendar.recurrence.none', fallback: 'Does not repeat' },
  { value: 'daily', key: 'calendar.recurrence.daily', fallback: 'Daily' },
  { value: 'weekly', key: 'calendar.recurrence.weekly', fallback: 'Weekly' },
  { value: 'monthly', key: 'calendar.recurrence.monthly', fallback: 'Monthly' },
  { value: 'yearly', key: 'calendar.recurrence.yearly', fallback: 'Yearly' },
  { value: 'custom', key: 'calendar.recurrence.custom', fallback: 'Custom…' },
];

interface EventModalProps {
  visible: boolean;
  event?: CalendarEvent | null;
  calendars: Calendar[];
  defaultDate?: Date;
  defaultCalendarId?: string;
  // Login address + identities + aliases; the first one is the organizer
  // address of invitations sent from this editor.
  currentUserEmails?: string[];
  // Client-side iCal subscriptions are read-only targets (#762).
  isSubscriptionCalendar?: (calendarId: string) => boolean;
  onSave: (
    data: Partial<CalendarEvent>,
    calendarId: string,
    options?: { sendSchedulingMessages?: boolean },
  ) => void | Promise<void>;
  onDelete?: (event: CalendarEvent) => void;
  onClose: () => void;
}

function nextHalfHour(d: Date): Date {
  const date = new Date(d);
  const min = date.getMinutes();
  const add = min < 30 ? 30 - min : 60 - min;
  date.setMinutes(date.getMinutes() + add, 0, 0);
  return date;
}

function buildDuration(start: Date, end: Date): string {
  const diffMin = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 60000));
  const days = Math.floor(diffMin / (24 * 60));
  const hours = Math.floor((diffMin % (24 * 60)) / 60);
  const mins = diffMin % 60;
  let dur = 'P';
  if (days > 0) dur += `${days}D`;
  if (hours > 0 || mins > 0) {
    dur += 'T';
    if (hours > 0) dur += `${hours}H`;
    if (mins > 0) dur += `${mins}M`;
  }
  return dur === 'P' ? 'PT0M' : dur;
}

function detectRecurrence(event: CalendarEvent | null | undefined): RecurrenceOption {
  const rule = event?.recurrenceRules?.[0];
  if (!rule) return 'none';
  if (isSimpleRecurrenceRule(rule)) {
    const f = rule.frequency.toLowerCase();
    if (f === 'daily' || f === 'weekly' || f === 'monthly' || f === 'yearly') {
      return f as RecurrenceOption;
    }
  }
  // Anything the simple presets can't represent is edited via the custom
  // recurrence editor.
  return 'custom';
}

function detectLocation(event: CalendarEvent | null | undefined): string {
  const locations = event?.locations;
  if (!locations) return '';
  const first = Object.values(locations)[0];
  return first?.name || '';
}

function detectVideoUrl(event: CalendarEvent | null | undefined): string {
  const v = event?.virtualLocations;
  if (!v) return '';
  const first = Object.values(v)[0];
  return first?.uri || '';
}

function buildLocations(name: string): Record<string, EventLocation> | undefined {
  const trimmed = name.trim();
  if (!trimmed) return undefined;
  return { 'loc-1': { '@type': 'Location', name: trimmed } };
}

function buildVirtualLocations(uri: string): Record<string, VirtualLocation> | undefined {
  const trimmed = uri.trim();
  if (!trimmed) return undefined;
  return { 'vloc-1': { '@type': 'VirtualLocation', name: 'Video call', uri: trimmed } };
}

function recurrenceFromOption(opt: RecurrenceOption): CalendarEvent['recurrenceRules'] | undefined {
  if (opt === 'none') return undefined;
  return [{ frequency: opt, interval: 1 }];
}

export function EventModal({
  visible,
  event,
  calendars,
  defaultDate,
  defaultCalendarId,
  currentUserEmails = [],
  isSubscriptionCalendar,
  onSave,
  onDelete,
  onClose,
}: EventModalProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const { locale, t } = useCalendarLocale();
  const timeFormat = useSettingsStore((s) => s.calendarTimeFormat);
  const timeLabelPattern = timePattern(timeFormat);
  const isEdit = !!event;

  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [allDay, setAllDay] = React.useState(false);
  const [start, setStart] = React.useState<Date>(() => nextHalfHour(defaultDate ?? new Date()));
  const [end, setEnd] = React.useState<Date>(() => addHours(nextHalfHour(defaultDate ?? new Date()), 1));
  // New events land in the explicitly requested calendar, else the account's
  // default calendar, else the first one.
  // Never default new events into a subscription / read-only calendar (#762).
  const fallbackCalendarId =
    defaultCalendarId
    || calendars.find((cal) => cal.isDefault && !cal.isShared && canCreateEventsIn(cal, isSubscriptionCalendar))?.id
    || calendars.find((cal) => canCreateEventsIn(cal, isSubscriptionCalendar))?.id
    || calendars[0]?.id
    || '';
  const [calendarId, setCalendarId] = React.useState<string>(fallbackCalendarId);
  // Attendee rows only — the organizer participant is rebuilt on save.
  const [attendees, setAttendees] = React.useState<Attendee[]>([]);
  const [recurrence, setRecurrence] = React.useState<RecurrenceOption>('none');
  const [customRule, setCustomRule] = React.useState<RecurrenceRule | null>(null);
  const [recurrenceEditorOpen, setRecurrenceEditorOpen] = React.useState(false);
  const [reminders, setReminders] = React.useState<Reminder[]>([]);
  // Alerts the picker can't show (absolute / end-relative / non-display)
  // ride along untouched so a save never drops them.
  const [preserved, setPreserved] = React.useState<Record<string, Alert>>({});
  const [customAmount, setCustomAmount] = React.useState('30');
  const [customUnit, setCustomUnit] = React.useState<ReminderUnit>('minutes');
  const [customReminderOpen, setCustomReminderOpen] = React.useState(false);
  // "Send invitations" (webmail default: on) decides sendSchedulingMessages.
  const [sendInvitations, setSendInvitations] = React.useState(true);
  const [location, setLocation] = React.useState('');
  const [videoUrl, setVideoUrl] = React.useState('');
  const [recurrenceOpen, setRecurrenceOpen] = React.useState(false);
  const [reminderPickerOpen, setReminderPickerOpen] = React.useState(false);
  const [calendarOpen, setCalendarOpen] = React.useState(false);
  const [showStartDate, setShowStartDate] = React.useState(false);
  const [showStartTime, setShowStartTime] = React.useState(false);
  const [showEndDate, setShowEndDate] = React.useState(false);
  const [showEndTime, setShowEndTime] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  // Reset the form when the editor opens or switches to another event only.
  // `calendars` and `currentUserEmails` get new identities when a calendar
  // push or the alias lookup lands, which used to wipe what the user typed.
  const formKey = visible ? event?.id ?? 'new' : null;
  React.useEffect(() => {
    if (!visible) return;
    if (event) {
      setTitle(event.title || '');
      setDescription(event.description || '');
      setAllDay(!!event.showWithoutTime);
      setStart(getEventStartDate(event));
      // All-day events store an exclusive end (start + P1D = next day 00:00);
      // the editor works with the inclusive last day, otherwise every re-save
      // grows the event by one day.
      setEnd(event.showWithoutTime ? getEventDisplayEndDate(event) : getEventEndDate(event));
      setCalendarId(getPrimaryCalendarId(event) || calendars[0]?.id || '');
      setAttendees(seedAttendees(event, currentUserEmails));
      const detected = detectRecurrence(event);
      setRecurrence(detected);
      setCustomRule(detected === 'custom' ? event.recurrenceRules?.[0] ?? null : null);
      setRecurrenceEditorOpen(false);
      setReminders(alertsToReminders(event.alerts));
      setPreserved(preservedAlerts(event.alerts));
      setSendInvitations(true);
      setCustomReminderOpen(false);
      setLocation(detectLocation(event));
      setVideoUrl(detectVideoUrl(event));
    } else {
      const d = defaultDate ? nextHalfHour(defaultDate) : nextHalfHour(new Date());
      setTitle('');
      setDescription('');
      setAllDay(false);
      setStart(d);
      setEnd(addHours(d, 1));
      setCalendarId(fallbackCalendarId);
      setAttendees([]);
      setRecurrence('none');
      setCustomRule(null);
      setRecurrenceEditorOpen(false);
      setReminders([]);
      setPreserved({});
      setSendInvitations(true);
      setCustomReminderOpen(false);
      setLocation('');
      setVideoUrl('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formKey]);

  // The calendars can arrive after a new-event form opened.
  React.useEffect(() => {
    if (visible && !calendarId && fallbackCalendarId) setCalendarId(fallbackCalendarId);
  }, [visible, calendarId, fallbackCalendarId]);

  React.useEffect(() => {
    if (allDay) {
      // `end` is the inclusive last day for all-day events, so a one-day
      // event has end === start (not the next day).
      const s = new Date(start);
      s.setHours(0, 0, 0, 0);
      const e = new Date(end);
      e.setHours(0, 0, 0, 0);
      if (e < s) e.setTime(s.getTime());
      setStart(s);
      setEnd(e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDay]);

  const updateStart = (next: Date) => {
    const diff = end.getTime() - start.getTime();
    setStart(next);
    setEnd(new Date(next.getTime() + (allDay ? Math.max(diff, 0) : Math.max(diff, 15 * 60_000))));
  };

  const updateEnd = (next: Date) => {
    if (allDay) {
      setEnd(next < start ? new Date(start) : next);
    } else if (next <= start) {
      setEnd(addMinutes(start, 15));
    } else {
      setEnd(next);
    }
  };

  const handleSave = async () => {
    if (!title.trim() || !calendarId) return;
    setSaving(true);
    try {
      // JSON drops `undefined`, so a cleared field must be sent as an explicit
      // `null` when editing or the server keeps the old value.
      const had = (key: keyof CalendarEvent): boolean => {
        const v = event?.[key];
        return !!v && (typeof v !== 'object' || Object.keys(v as object).length > 0);
      };
      const clearedOr = <T,>(value: T | undefined, key: keyof CalendarEvent): T | null | undefined =>
        value !== undefined ? value : isEdit && had(key) ? null : undefined;

      const recurrenceRules =
        recurrence === 'custom'
          ? customRule
            ? [customRule]
            : undefined
          : recurrenceFromOption(recurrence);
      const data: Partial<CalendarEvent> = {
        title: title.trim(),
        description: description.trim() || (isEdit && event?.description ? '' : undefined),
        showWithoutTime: allDay || (isEdit ? false : undefined),
        start: allDay
          ? format(start, "yyyy-MM-dd'T'00:00:00")
          : format(start, "yyyy-MM-dd'T'HH:mm:ss"),
        duration: allDay ? buildAllDayDuration(start, end) : buildDuration(start, end),
        // A floating (zone-less) start renders at a different instant for
        // every viewer; label the wall-clock with the zone it was entered in.
        // All-day events are date-only and carry no zone.
        timeZone: allDay ? null : getEffectiveTimeZone(),
        recurrenceRules: clearedOr(recurrenceRules, 'recurrenceRules'),
        alerts: clearedOr(remindersToAlerts(reminders, preserved), 'alerts'),
        useDefaultAlerts: reminders.length > 0 ? false : undefined,
        locations: clearedOr(buildLocations(location), 'locations'),
        virtualLocations: clearedOr(buildVirtualLocations(videoUrl), 'virtualLocations'),
      };
      const organizerEmail = currentUserEmails[0];
      if (attendees.length > 0 && organizerEmail) {
        const organizerName =
          (event ? getParticipantList(event).find((p) => p.isOrganizer)?.name : '') || '';
        data.participants = buildParticipantMap(
          { name: organizerName, email: organizerEmail },
          attendees,
        );
        // Stalwart (calcard) derives the iCalendar ORGANIZER property solely from
        // organizerCalendarAddress; without it no ORGANIZER is emitted and iTIP
        // scheduling is silently skipped, so no invites are sent.
        data.organizerCalendarAddress = `mailto:${organizerEmail}`;
      } else if (attendees.length === 0 && isEdit && had('participants')) {
        data.participants = null;
        // Also clear the retired replyTo that older releases wrote.
        if (event?.replyTo) data.replyTo = null;
        if (event?.organizerCalendarAddress) data.organizerCalendarAddress = null;
      }
      if (data.recurrenceRules === null) {
        // Dropping the rule leaves per-occurrence data dangling.
        if (had('recurrenceOverrides')) data.recurrenceOverrides = null;
        if (had('excludedRecurrenceRules')) data.excludedRecurrenceRules = null;
      }
      for (const key of Object.keys(data) as (keyof CalendarEvent)[]) {
        if (data[key] === undefined) delete data[key];
      }
      await onSave(data, calendarId, {
        sendSchedulingMessages: attendees.length > 0 && sendInvitations,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    if (event && onDelete) onDelete(event);
  };

  const selectedCalendar = calendars.find((c) => c.id === calendarId);
  // Calendars offered as create/move targets: writable, non-subscription, in
  // the same account as the event being edited (a cross-account move would
  // need delete + recreate), plus the event's current calendar so an
  // in-place edit never blanks the picker (#762).
  const selectableCalendars = React.useMemo(() => {
    const eventAccount = event ? (event.accountId ?? null) : null;
    return calendars.filter((c) => {
      if (c.id === calendarId) return true;
      if (!canCreateEventsIn(c, isSubscriptionCalendar)) return false;
      if (event && (c.accountId ?? null) !== eventAccount) return false;
      return true;
    });
  }, [calendars, calendarId, event, isSubscriptionCalendar]);
  const recurrenceOption = RECURRENCE_OPTIONS.find((o) => o.value === recurrence);
  const recurrenceLabel =
    recurrence === 'custom'
      ? (customRule && buildRecurrenceSummary(customRule)) || t('calendar.recurrence.custom', 'Custom…')
      : recurrenceOption
        ? t(recurrenceOption.key, recurrenceOption.fallback)
        : t('calendar.recurrence.none', 'Does not repeat');

  const addReminder = (minutesBefore: number) => {
    setReminderPickerOpen(false);
    setReminders((prev) =>
      prev.some((r) => r.minutesBefore === minutesBefore)
        ? prev
        : [...prev, { minutesBefore }].sort((a, b) => b.minutesBefore - a.minutesBefore),
    );
  };
  const removeReminder = (minutesBefore: number) => {
    setReminders((prev) => prev.filter((r) => r.minutesBefore !== minutesBefore));
  };
  const availablePresets = REMINDER_PRESETS.filter(
    (p) => !reminders.some((r) => r.minutesBefore === p),
  );

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <Pressable onPress={onClose} hitSlop={8} style={styles.headerBtn}>
            <X size={20} color={c.text} />
          </Pressable>
          <Text style={styles.headerTitle}>
            {isEdit ? t('calendar.events.edit', 'Edit event') : t('calendar.events.new_event', 'New event')}
          </Text>
          <Button
            variant="default"
            size="sm"
            onPress={handleSave}
            disabled={!title.trim() || !calendarId}
            loading={saving}
          >
            {t('calendar.form.save', 'Save')}
          </Button>
        </View>

        <ScrollView
          style={styles.body}
          contentContainerStyle={styles.bodyContent}
          keyboardShouldPersistTaps="handled"
        >
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder={t('calendar.form.title', 'Title')}
            placeholderTextColor={c.textMuted}
            style={styles.titleInput}
          />

          <Section
            icon={<CalendarIcon size={16} color={c.textMuted} />}
            label={t('calendar.form.calendar_select', 'Calendar')}
          >
            <Pressable
              style={styles.fieldButton}
              onPress={() => setCalendarOpen((v) => !v)}
            >
              <View style={styles.calendarRow}>
                {selectedCalendar && (
                  <View
                    style={[
                      styles.calendarSwatch,
                      { backgroundColor: getCalendarColor(selectedCalendar) },
                    ]}
                  />
                )}
                <Text style={styles.fieldText}>
                  {selectedCalendar?.name || t('calendar.form.calendar_select', 'Calendar')}
                </Text>
              </View>
            </Pressable>
            {calendarOpen && (
              <View style={styles.popover}>
                {selectableCalendars.map((c) => (
                  <Pressable
                    key={c.id}
                    style={[
                      styles.popoverRow,
                      c.id === calendarId && styles.popoverRowActive,
                    ]}
                    onPress={() => {
                      setCalendarId(c.id);
                      setCalendarOpen(false);
                    }}
                  >
                    <View
                      style={[
                        styles.calendarSwatch,
                        { backgroundColor: getCalendarColor(c) },
                      ]}
                    />
                    <Text style={styles.popoverRowText}>{c.name}</Text>
                  </Pressable>
                ))}
              </View>
            )}
          </Section>

          <Section icon={<Clock size={16} color={c.textMuted} />} label={t('calendar.form.time', 'Time')}>
            <View style={styles.allDayRow}>
              <Text style={styles.fieldText}>{t('calendar.form.all_day_event', 'All-day event')}</Text>
              <Switch
                value={allDay}
                onValueChange={setAllDay}
                thumbColor={allDay ? c.primary : c.textMuted}
                trackColor={{ false: c.surface, true: c.primaryBg }}
              />
            </View>

            <View style={styles.dateRow}>
              <Text style={styles.dateLabel}>{t('calendar.form.start_date', 'Start date')}</Text>
              <View style={styles.datePickers}>
                <Pressable
                  style={styles.dateBtn}
                  onPress={() => setShowStartDate(true)}
                >
                  <Text style={styles.dateText}>{format(start, 'EEE, MMM d', { locale })}</Text>
                </Pressable>
                {!allDay && (
                  <Pressable
                    style={styles.dateBtn}
                    onPress={() => setShowStartTime(true)}
                  >
                    <Text style={styles.dateText}>{format(start, timeLabelPattern, { locale })}</Text>
                  </Pressable>
                )}
              </View>
            </View>

            <View style={styles.dateRow}>
              <Text style={styles.dateLabel}>{t('calendar.form.end_date', 'End date')}</Text>
              <View style={styles.datePickers}>
                <Pressable
                  style={styles.dateBtn}
                  onPress={() => setShowEndDate(true)}
                >
                  <Text style={styles.dateText}>{format(end, 'EEE, MMM d', { locale })}</Text>
                </Pressable>
                {!allDay && (
                  <Pressable
                    style={styles.dateBtn}
                    onPress={() => setShowEndTime(true)}
                  >
                    <Text style={styles.dateText}>{format(end, timeLabelPattern, { locale })}</Text>
                  </Pressable>
                )}
              </View>
            </View>
          </Section>

          <Section icon={<Repeat size={16} color={c.textMuted} />} label={t('calendar.recurrence.title', 'Recurrence')}>
            <Pressable
              style={styles.fieldButton}
              onPress={() => setRecurrenceOpen((v) => !v)}
            >
              <Text style={styles.fieldText}>{recurrenceLabel}</Text>
            </Pressable>
            {recurrenceOpen && (
              <View style={styles.popover}>
                {RECURRENCE_OPTIONS.map((opt) => (
                  <Pressable
                    key={opt.value}
                    style={[
                      styles.popoverRow,
                      opt.value === recurrence && styles.popoverRowActive,
                    ]}
                    onPress={() => {
                      setRecurrenceOpen(false);
                      if (opt.value === 'custom') {
                        setRecurrenceEditorOpen(true);
                        return;
                      }
                      setRecurrence(opt.value);
                      setCustomRule(null);
                      setRecurrenceEditorOpen(false);
                    }}
                  >
                    <Text style={styles.popoverRowText}>{t(opt.key, opt.fallback)}</Text>
                  </Pressable>
                ))}
              </View>
            )}
            {recurrenceEditorOpen && (
              <RecurrenceEditor
                rule={customRule}
                eventStart={start}
                onSave={(rule) => {
                  setCustomRule(rule);
                  setRecurrence('custom');
                  setRecurrenceEditorOpen(false);
                }}
                onCancel={() => setRecurrenceEditorOpen(false)}
              />
            )}
            {recurrence === 'custom' && customRule && !recurrenceEditorOpen && (
              <Pressable style={styles.addRow} onPress={() => setRecurrenceEditorOpen(true)}>
                <Text style={styles.addRowText}>{t('calendar.recurrence.edit_custom', 'Edit custom recurrence')}</Text>
              </Pressable>
            )}
          </Section>

          <Section icon={<Bell size={16} color={c.textMuted} />} label={t('calendar.alerts.title', 'Reminders')}>
            {reminders.length > 0 && (
              <View style={{ gap: spacing.xs }}>
                {reminders.map((r) => (
                  <View key={r.minutesBefore} style={styles.reminderRow}>
                    <Text style={styles.fieldText}>{formatReminder(r.minutesBefore, t)}</Text>
                    <Pressable
                      onPress={() => removeReminder(r.minutesBefore)}
                      hitSlop={8}
                      style={styles.reminderRemove}
                    >
                      <X size={16} color={c.textMuted} />
                    </Pressable>
                  </View>
                ))}
              </View>
            )}
            {availablePresets.length > 0 && (
              <Pressable
                style={styles.addRow}
                onPress={() => setReminderPickerOpen((v) => !v)}
              >
                <Plus size={16} color={c.primary} />
                <Text style={styles.addRowText}>
                  {t('calendar.alerts.add', 'Add reminder')}
                </Text>
              </Pressable>
            )}
            {reminderPickerOpen && (
              <View style={styles.popover}>
                {availablePresets.map((preset) => (
                  <Pressable
                    key={preset}
                    style={styles.popoverRow}
                    onPress={() => addReminder(preset)}
                  >
                    <Text style={styles.popoverRowText}>{formatReminder(preset, t)}</Text>
                  </Pressable>
                ))}
                <Pressable
                  style={styles.popoverRow}
                  onPress={() => { setReminderPickerOpen(false); setCustomReminderOpen(true); }}
                >
                  <Text style={styles.popoverRowText}>{t('calendar.recurrence.custom', 'Custom…')}</Text>
                </Pressable>
              </View>
            )}
            {customReminderOpen && (
              <View style={styles.customReminderRow}>
                <TextInput
                  value={customAmount}
                  onChangeText={(v) => setCustomAmount(v.replace(/[^0-9]/g, ''))}
                  keyboardType="number-pad"
                  style={styles.customAmountInput}
                  placeholder="30"
                  placeholderTextColor={c.textMuted}
                />
                <View style={styles.customUnits}>
                  {(['minutes', 'hours', 'days', 'weeks'] as ReminderUnit[]).map((unit) => (
                    <Pressable
                      key={unit}
                      onPress={() => setCustomUnit(unit)}
                      style={[styles.unitChip, customUnit === unit && styles.unitChipActive]}
                    >
                      <Text style={[styles.unitChipText, customUnit === unit && styles.unitChipTextActive]}>
                        {t(`calendar.alerts.unit_${unit}_before`, `${unit} before`)}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <Button
                  size="sm"
                  onPress={() => {
                    const amount = parseInt(customAmount, 10);
                    if (!Number.isFinite(amount) || amount < 0) return;
                    addReminder(amount * REMINDER_UNIT_MINUTES[customUnit]);
                    setCustomReminderOpen(false);
                  }}
                >
                  {t('calendar.alerts.add', 'Add reminder')}
                </Button>
              </View>
            )}
          </Section>

          <Section icon={<MapPin size={16} color={c.textMuted} />} label={t('calendar.form.location', 'Location')}>
            <TextInput
              value={location}
              onChangeText={setLocation}
              placeholder={t('calendar.form.location_placeholder', 'Place or address')}
              placeholderTextColor={c.textMuted}
              style={styles.fieldButton}
            />
          </Section>

          <Section icon={<Video size={16} color={c.textMuted} />} label={t('calendar.form.meeting_link', 'Meeting link')}>
            <TextInput
              value={videoUrl}
              onChangeText={setVideoUrl}
              placeholder="https://meet.example.com/…"
              placeholderTextColor={c.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={styles.fieldButton}
            />
          </Section>

          <Section
            icon={<AlignLeft size={16} color={c.textMuted} />}
            label={t('calendar.form.description', 'Description')}
          >
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder={t('calendar.form.description_placeholder', 'Notes, agenda…')}
              placeholderTextColor={c.textMuted}
              multiline
              style={styles.descriptionInput}
            />
          </Section>

          <Section
            icon={<Users size={16} color={c.textMuted} />}
            label={t('calendar.participants.title', 'Participants')}
          >
            <ParticipantInput
              attendees={attendees}
              onAdd={(a) => setAttendees((prev) => [...prev, a])}
              onRemove={(email) =>
                setAttendees((prev) => prev.filter((a) => a.email.toLowerCase() !== email.toLowerCase()))
              }
            />
            {attendees.length > 0 && (
              <View style={styles.allDayRow}>
                <Text style={[styles.fieldText, { flex: 1 }]}>
                  {t('calendar.participants.send_invitations', 'Send invitations to participants')}
                </Text>
                <Switch
                  value={sendInvitations}
                  onValueChange={setSendInvitations}
                  thumbColor={sendInvitations ? c.primary : c.textMuted}
                  trackColor={{ false: c.surface, true: c.primaryBg }}
                />
              </View>
            )}
          </Section>

          {isEdit && onDelete && (
            <Pressable
              style={({ pressed }) => [
                styles.deleteBtn,
                pressed && styles.deleteBtnPressed,
              ]}
              onPress={handleDelete}
            >
              <Trash2 size={16} color={c.error} />
              <Text style={styles.deleteBtnText}>{t('calendar.events.delete', 'Delete event')}</Text>
            </Pressable>
          )}
        </ScrollView>

        {showStartDate && (
          <DateTimePicker
            value={start}
            mode="date"
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            onChange={(_, d) => {
              setShowStartDate(false);
              if (d) {
                const next = new Date(start);
                next.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
                updateStart(next);
              }
            }}
          />
        )}
        {showStartTime && (
          <DateTimePicker
            value={start}
            mode="time"
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            onChange={(_, d) => {
              setShowStartTime(false);
              if (d) {
                const next = new Date(start);
                next.setHours(d.getHours(), d.getMinutes(), 0, 0);
                updateStart(next);
              }
            }}
          />
        )}
        {showEndDate && (
          <DateTimePicker
            value={end}
            mode="date"
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            onChange={(_, d) => {
              setShowEndDate(false);
              if (d) {
                const next = new Date(end);
                next.setFullYear(d.getFullYear(), d.getMonth(), d.getDate());
                updateEnd(next);
              }
            }}
          />
        )}
        {showEndTime && (
          <DateTimePicker
            value={end}
            mode="time"
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            onChange={(_, d) => {
              setShowEndTime(false);
              if (d) {
                const next = new Date(end);
                next.setHours(d.getHours(), d.getMinutes(), 0, 0);
                updateEnd(next);
              }
            }}
          />
        )}
      </SafeAreaView>
    </Modal>
  );
}

function Section({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <View style={styles.sectionIcon}>{icon}</View>
        <Text style={styles.sectionLabel}>{label}</Text>
      </View>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    gap: spacing.md,
  },
  headerBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
  headerTitle: { flex: 1, ...typography.h3, color: c.text },

  body: { flex: 1 },
  bodyContent: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxxl },

  titleInput: {
    ...typography.h2,
    color: c.text,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
    paddingVertical: spacing.sm,
  },

  section: { gap: spacing.sm },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sectionIcon: { width: 16 },
  sectionLabel: { ...typography.bodyMedium, color: c.textSecondary },
  sectionBody: { gap: spacing.sm },

  fieldButton: {
    minHeight: 40,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
    justifyContent: 'center',
  },
  fieldText: { ...typography.body, color: c.text },

  calendarRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  calendarSwatch: { width: 12, height: 12, borderRadius: 6 },

  reminderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
  },
  reminderRemove: { padding: 2 },
  customReminderRow: {
    gap: spacing.sm,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.sm,
    backgroundColor: c.surface,
  },
  customAmountInput: {
    ...typography.body,
    color: c.text,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: c.background,
  },
  customUnits: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  unitChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.background,
  },
  unitChipActive: { backgroundColor: c.primary, borderColor: c.primary },
  unitChipText: { ...typography.caption, color: c.text },
  unitChipTextActive: { color: c.primaryForeground },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  addRowText: { ...typography.body, color: c.primary },

  popover: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.sm,
    backgroundColor: c.surface,
    overflow: 'hidden',
  },
  popoverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.borderLight,
  },
  popoverRowActive: { backgroundColor: c.primaryBg },
  popoverRowText: { ...typography.body, color: c.text },

  allDayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
  },
  dateLabel: { ...typography.body, color: c.textSecondary, flex: 1 },
  datePickers: { flexDirection: 'row', gap: spacing.sm },
  dateBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.xs,
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.border,
  },
  dateText: { ...typography.body, color: c.text },

  descriptionInput: {
    minHeight: 80,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.surface,
    color: c.text,
    ...typography.body,
    textAlignVertical: 'top',
  },

  deleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.errorBorder,
    marginTop: spacing.lg,
  },
  deleteBtnPressed: { backgroundColor: c.errorBg },
  deleteBtnText: { ...typography.bodyMedium, color: c.error },
  });
}
