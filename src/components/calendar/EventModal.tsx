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
  Repeat,
  Bell,
  Users,
  Trash2,
} from 'lucide-react-native';
import { addHours, addMinutes, format } from 'date-fns';
import type { Calendar, CalendarEvent, Participant } from '../../api/types';
import { colors, radius, spacing, typography } from '../../theme/tokens';
import {
  buildAllDayDuration,
  getCalendarColor,
  getEventEndDate,
  getEventStartDate,
  getPrimaryCalendarId,
} from '../../lib/calendar-utils';
import { Button } from '..';
import { ParticipantInput } from './ParticipantInput';

type RecurrenceOption = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';
type AlertOption = 'none' | 'at_time' | '5' | '15' | '30' | '60' | '1440';

const RECURRENCE_OPTIONS: { value: RecurrenceOption; label: string }[] = [
  { value: 'none', label: 'Does not repeat' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
];

const ALERT_OPTIONS: { value: AlertOption; label: string }[] = [
  { value: 'none', label: 'No reminder' },
  { value: 'at_time', label: 'At time of event' },
  { value: '5', label: '5 minutes before' },
  { value: '15', label: '15 minutes before' },
  { value: '30', label: '30 minutes before' },
  { value: '60', label: '1 hour before' },
  { value: '1440', label: '1 day before' },
];

interface EventModalProps {
  visible: boolean;
  event?: CalendarEvent | null;
  calendars: Calendar[];
  defaultDate?: Date;
  defaultCalendarId?: string;
  onSave: (data: Partial<CalendarEvent>, calendarId: string) => void | Promise<void>;
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
  const f = rule.frequency.toLowerCase();
  if (f === 'daily' || f === 'weekly' || f === 'monthly' || f === 'yearly') {
    return f as RecurrenceOption;
  }
  return 'none';
}

function detectAlert(event: CalendarEvent | null | undefined): AlertOption {
  const alerts = event?.alerts;
  if (!alerts) return 'none';
  const first = Object.values(alerts)[0];
  if (!first) return 'none';
  const offset = first.trigger?.offset;
  if (!offset) return 'none';
  if (offset === 'PT0S' || offset === '-PT0S') return 'at_time';
  const min = offset.match(/-?PT(\d+)M$/);
  if (min) {
    const v = min[1];
    if (v === '5' || v === '15' || v === '30') return v as AlertOption;
  }
  const hr = offset.match(/-?PT(\d+)H$/);
  if (hr && hr[1] === '1') return '60';
  const day = offset.match(/-?P(\d+)D/);
  if (day && day[1] === '1') return '1440';
  return 'none';
}

function alertFromOption(opt: AlertOption): CalendarEvent['alerts'] | undefined {
  if (opt === 'none') return undefined;
  let offset = '-PT0M';
  if (opt === 'at_time') offset = 'PT0S';
  else if (opt === '60') offset = '-PT1H';
  else if (opt === '1440') offset = '-P1D';
  else offset = `-PT${opt}M`;
  return {
    'a-1': {
      trigger: { '@type': 'OffsetTrigger', offset },
      action: 'display',
    },
  };
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
  onSave,
  onDelete,
  onClose,
}: EventModalProps) {
  const isEdit = !!event;

  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [allDay, setAllDay] = React.useState(false);
  const [start, setStart] = React.useState<Date>(() => nextHalfHour(defaultDate ?? new Date()));
  const [end, setEnd] = React.useState<Date>(() => addHours(nextHalfHour(defaultDate ?? new Date()), 1));
  const [calendarId, setCalendarId] = React.useState<string>(defaultCalendarId || calendars[0]?.id || '');
  const [participants, setParticipants] = React.useState<Record<string, Participant>>({});
  const [recurrence, setRecurrence] = React.useState<RecurrenceOption>('none');
  const [alert, setAlert] = React.useState<AlertOption>('none');
  const [recurrenceOpen, setRecurrenceOpen] = React.useState(false);
  const [alertOpen, setAlertOpen] = React.useState(false);
  const [calendarOpen, setCalendarOpen] = React.useState(false);
  const [showStartDate, setShowStartDate] = React.useState(false);
  const [showStartTime, setShowStartTime] = React.useState(false);
  const [showEndDate, setShowEndDate] = React.useState(false);
  const [showEndTime, setShowEndTime] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!visible) return;
    if (event) {
      setTitle(event.title || '');
      setDescription(event.description || '');
      setAllDay(!!event.showWithoutTime);
      setStart(getEventStartDate(event));
      setEnd(getEventEndDate(event));
      setCalendarId(getPrimaryCalendarId(event) || calendars[0]?.id || '');
      setParticipants(event.participants || {});
      setRecurrence(detectRecurrence(event));
      setAlert(detectAlert(event));
    } else {
      const d = defaultDate ? nextHalfHour(defaultDate) : nextHalfHour(new Date());
      setTitle('');
      setDescription('');
      setAllDay(false);
      setStart(d);
      setEnd(addHours(d, 1));
      setCalendarId(defaultCalendarId || calendars[0]?.id || '');
      setParticipants({});
      setRecurrence('none');
      setAlert('none');
    }
  }, [visible, event, defaultDate, defaultCalendarId, calendars]);

  React.useEffect(() => {
    if (allDay) {
      const s = new Date(start);
      s.setHours(0, 0, 0, 0);
      const e = new Date(end);
      e.setHours(0, 0, 0, 0);
      if (e <= s) e.setDate(s.getDate() + 1);
      setStart(s);
      setEnd(e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDay]);

  const updateStart = (next: Date) => {
    const diff = end.getTime() - start.getTime();
    setStart(next);
    setEnd(new Date(next.getTime() + Math.max(diff, 15 * 60_000)));
  };

  const updateEnd = (next: Date) => {
    if (next <= start) {
      setEnd(addMinutes(start, 15));
    } else {
      setEnd(next);
    }
  };

  const handleSave = async () => {
    if (!title.trim() || !calendarId) return;
    setSaving(true);
    try {
      const data: Partial<CalendarEvent> = {
        title: title.trim(),
        description: description.trim() || undefined,
        showWithoutTime: allDay || undefined,
        start: allDay
          ? format(start, "yyyy-MM-dd'T'00:00:00")
          : format(start, "yyyy-MM-dd'T'HH:mm:ss"),
        duration: allDay ? buildAllDayDuration(start, end) : buildDuration(start, end),
        participants: Object.keys(participants).length > 0 ? participants : undefined,
        recurrenceRules: recurrenceFromOption(recurrence),
        alerts: alertFromOption(alert),
      };
      await onSave(data, calendarId);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    if (event && onDelete) onDelete(event);
  };

  const selectedCalendar = calendars.find((c) => c.id === calendarId);
  const recurrenceLabel = RECURRENCE_OPTIONS.find((o) => o.value === recurrence)?.label || 'None';
  const alertLabel = ALERT_OPTIONS.find((o) => o.value === alert)?.label || 'None';

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
            <X size={20} color={colors.text} />
          </Pressable>
          <Text style={styles.headerTitle}>{isEdit ? 'Edit event' : 'New event'}</Text>
          <Button
            variant="default"
            size="sm"
            onPress={handleSave}
            disabled={!title.trim() || !calendarId}
            loading={saving}
          >
            Save
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
            placeholder="Title"
            placeholderTextColor={colors.textMuted}
            style={styles.titleInput}
          />

          <Section
            icon={<CalendarIcon size={16} color={colors.textMuted} />}
            label="Calendar"
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
                  {selectedCalendar?.name || 'Pick a calendar'}
                </Text>
              </View>
            </Pressable>
            {calendarOpen && (
              <View style={styles.popover}>
                {calendars.map((c) => (
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

          <Section icon={<Clock size={16} color={colors.textMuted} />} label="Time">
            <View style={styles.allDayRow}>
              <Text style={styles.fieldText}>All-day</Text>
              <Switch
                value={allDay}
                onValueChange={setAllDay}
                thumbColor={allDay ? colors.primary : colors.textMuted}
                trackColor={{ false: colors.surface, true: colors.primaryBg }}
              />
            </View>

            <View style={styles.dateRow}>
              <Text style={styles.dateLabel}>Starts</Text>
              <View style={styles.datePickers}>
                <Pressable
                  style={styles.dateBtn}
                  onPress={() => setShowStartDate(true)}
                >
                  <Text style={styles.dateText}>{format(start, 'EEE, MMM d')}</Text>
                </Pressable>
                {!allDay && (
                  <Pressable
                    style={styles.dateBtn}
                    onPress={() => setShowStartTime(true)}
                  >
                    <Text style={styles.dateText}>{format(start, 'HH:mm')}</Text>
                  </Pressable>
                )}
              </View>
            </View>

            <View style={styles.dateRow}>
              <Text style={styles.dateLabel}>Ends</Text>
              <View style={styles.datePickers}>
                <Pressable
                  style={styles.dateBtn}
                  onPress={() => setShowEndDate(true)}
                >
                  <Text style={styles.dateText}>{format(end, 'EEE, MMM d')}</Text>
                </Pressable>
                {!allDay && (
                  <Pressable
                    style={styles.dateBtn}
                    onPress={() => setShowEndTime(true)}
                  >
                    <Text style={styles.dateText}>{format(end, 'HH:mm')}</Text>
                  </Pressable>
                )}
              </View>
            </View>
          </Section>

          <Section icon={<Repeat size={16} color={colors.textMuted} />} label="Repeat">
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
                      setRecurrence(opt.value);
                      setRecurrenceOpen(false);
                    }}
                  >
                    <Text style={styles.popoverRowText}>{opt.label}</Text>
                  </Pressable>
                ))}
              </View>
            )}
          </Section>

          <Section icon={<Bell size={16} color={colors.textMuted} />} label="Reminder">
            <Pressable
              style={styles.fieldButton}
              onPress={() => setAlertOpen((v) => !v)}
            >
              <Text style={styles.fieldText}>{alertLabel}</Text>
            </Pressable>
            {alertOpen && (
              <View style={styles.popover}>
                {ALERT_OPTIONS.map((opt) => (
                  <Pressable
                    key={opt.value}
                    style={[
                      styles.popoverRow,
                      opt.value === alert && styles.popoverRowActive,
                    ]}
                    onPress={() => {
                      setAlert(opt.value);
                      setAlertOpen(false);
                    }}
                  >
                    <Text style={styles.popoverRowText}>{opt.label}</Text>
                  </Pressable>
                ))}
              </View>
            )}
          </Section>

          <Section
            icon={<MapPin size={16} color={colors.textMuted} />}
            label="Description"
          >
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="Notes, location, link…"
              placeholderTextColor={colors.textMuted}
              multiline
              style={styles.descriptionInput}
            />
          </Section>

          <Section
            icon={<Users size={16} color={colors.textMuted} />}
            label="Participants"
          >
            <ParticipantInput
              participants={participants}
              onChange={setParticipants}
            />
          </Section>

          {isEdit && onDelete && (
            <Pressable
              style={({ pressed }) => [
                styles.deleteBtn,
                pressed && styles.deleteBtnPressed,
              ]}
              onPress={handleDelete}
            >
              <Trash2 size={16} color={colors.error} />
              <Text style={styles.deleteBtnText}>Delete event</Text>
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.md,
  },
  headerBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
  headerTitle: { flex: 1, ...typography.h3, color: colors.text },

  body: { flex: 1 },
  bodyContent: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxxl },

  titleInput: {
    ...typography.h2,
    color: colors.text,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingVertical: spacing.sm,
  },

  section: { gap: spacing.sm },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sectionIcon: { width: 16 },
  sectionLabel: { ...typography.bodyMedium, color: colors.textSecondary },
  sectionBody: { gap: spacing.sm },

  fieldButton: {
    minHeight: 40,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    justifyContent: 'center',
  },
  fieldText: { ...typography.body, color: colors.text },

  calendarRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  calendarSwatch: { width: 12, height: 12, borderRadius: 6 },

  popover: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  popoverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  popoverRowActive: { backgroundColor: colors.primaryBg },
  popoverRowText: { ...typography.body, color: colors.text },

  allDayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  dateLabel: { ...typography.body, color: colors.textSecondary, flex: 1 },
  datePickers: { flexDirection: 'row', gap: spacing.sm },
  dateBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.xs,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dateText: { ...typography.body, color: colors.text },

  descriptionInput: {
    minHeight: 80,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    color: colors.text,
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
    borderColor: colors.errorBorder,
    marginTop: spacing.lg,
  },
  deleteBtnPressed: { backgroundColor: colors.errorBg },
  deleteBtnText: { ...typography.bodyMedium, color: colors.error },
});
