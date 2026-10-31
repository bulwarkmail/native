import React from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { Check, Plus, X } from '../icons';
import type { Alert, Calendar } from '../../api/types';
import {
  REMINDER_PRESETS,
  alertsToReminders,
  calendarDefaultAlerts,
  defaultAlertIdPrefix,
  formatReminder,
  preservedAlerts,
  remindersToDefaultAlerts,
  sameReminders,
  type Reminder,
} from '../../lib/calendar-alerts';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore, type TranslateFn } from '../../stores/locale-store';
import { CALENDAR_COLOR_PALETTE, calendarColorName, getCalendarColor } from '../../lib/calendar-utils';
import { customColorGrid, normalizeHexColor } from '../../lib/calendar-custom-color';

const CUSTOM_COLOR_GRID = customColorGrid();
import Button from '../Button';
import { MODAL_ORIENTATIONS } from '../../lib/modal-orientations';
import { useSheetInsets } from '../../lib/use-layout';

export interface CalendarEditValues {
  name: string;
  color: string;
  description: string;
  /** Set only when the user changed them. */
  defaultAlertsWithTime?: Record<string, Alert>;
  defaultAlertsWithoutTime?: Record<string, Alert>;
}

/** One list of a calendar's default reminders: the times, a remove button each, presets to add. */
function DefaultRemindersEditor({
  label,
  reminders,
  keptCount,
  onChange,
  styles,
  c,
  t,
}: {
  label: string;
  reminders: Reminder[];
  keptCount: number;
  onChange: (next: Reminder[]) => void;
  styles: ReturnType<typeof makeStyles>;
  c: ThemePalette;
  t: TranslateFn;
}) {
  const [picking, setPicking] = React.useState(false);
  const available = REMINDER_PRESETS.filter((p) => !reminders.some((r) => r.minutesBefore === p));
  return (
    <View style={styles.reminders}>
      <Text style={styles.label}>{label}</Text>
      {reminders.length === 0 && keptCount === 0 && (
        <Text style={styles.muted}>{t('calendar.alerts.none', 'No reminders')}</Text>
      )}
      {reminders.map((r) => (
        <View key={r.minutesBefore} style={styles.reminderRow}>
          <Text style={styles.reminderText}>{formatReminder(r.minutesBefore, t)}</Text>
          <Pressable
            onPress={() => onChange(reminders.filter((x) => x.minutesBefore !== r.minutesBefore))}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('calendar.alerts.remove', 'Remove reminder')}
          >
            <X size={16} color={c.textMuted} />
          </Pressable>
        </View>
      ))}
      {keptCount > 0 && (
        <Text style={styles.muted}>
          {t('calendar.alerts.kept', "{count, plural, one {# more reminder that can't be edited here is kept} other {# more reminders that can't be edited here are kept}}", { count: keptCount })}
        </Text>
      )}
      {available.length > 0 && (
        <Pressable style={styles.addRow} onPress={() => setPicking((v) => !v)} accessibilityRole="button">
          <Plus size={16} color={c.primary} />
          <Text style={styles.addRowText}>{t('calendar.alerts.add', 'Add reminder')}</Text>
        </Pressable>
      )}
      {picking && (
        <View style={styles.presets}>
          {available.map((preset) => (
            <Pressable
              key={preset}
              style={styles.preset}
              onPress={() => {
                onChange([...reminders, { minutesBefore: preset }]);
                setPicking(false);
              }}
            >
              <Text style={styles.presetText}>{formatReminder(preset, t)}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * The default alerts saved for `calendar`'s timed or all-day events: the
 * reminders, and the alerts the lists can't show (`kept`), every one under
 * the calendar's own id prefix. Ids must be unique in the account, and a kept
 * alert had the id another client gave it: when another calendar used that
 * id too, Stalwart 1.0 refused the whole Calendar/set, its name and colour
 * with it.
 */
export function defaultAlertsToSave(
  calendar: Pick<Calendar, 'id' | 'originalId'>,
  allDay: boolean,
  reminders: Reminder[],
  kept: Record<string, Alert>,
): Record<string, Alert> {
  const prefix = defaultAlertIdPrefix(calendar, allDay);
  const rekeyed: Record<string, Alert> = {};
  let n = 0;
  for (const alert of Object.values(kept)) rekeyed[`${prefix}-${++n}`] = alert;
  return remindersToDefaultAlerts(reminders, rekeyed, prefix);
}

interface CalendarEditSheetProps {
  visible: boolean;
  // Existing calendar to edit; null creates a new one.
  calendar: Calendar | null;
  onSave: (values: CalendarEditValues) => Promise<void>;
  onClose: () => void;
}

// Create / rename / recolour / describe a calendar. The same fields the
// webmail's calendar-management settings offer, as a bottom sheet.
export function CalendarEditSheet({ visible, calendar, onSave, onClose }: CalendarEditSheetProps) {
  // Centred on a wide window, clear of side insets in landscape.
  const sheetInsets = useSheetInsets();
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const [name, setName] = React.useState('');
  const [color, setColor] = React.useState<string>(CALENDAR_COLOR_PALETTE[0]);
  const [description, setDescription] = React.useState('');
  // The colour as typed in the hex field; a pick from the swatches fills it.
  const [hexInput, setHexInput] = React.useState('');
  const [moreColors, setMoreColors] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // The calendar's default reminders (#1209): the owner's to set, for an
  // existing calendar. What the lists can't show is written back unchanged.
  const editsDefaults = !!calendar && !calendar.isShared;
  const initialTimed = React.useMemo(() => alertsToReminders(calendarDefaultAlerts(calendar, false)), [calendar]);
  const initialAllDay = React.useMemo(() => alertsToReminders(calendarDefaultAlerts(calendar, true)), [calendar]);
  const keptTimed = React.useMemo(() => preservedAlerts(calendarDefaultAlerts(calendar, false)), [calendar]);
  const keptAllDay = React.useMemo(() => preservedAlerts(calendarDefaultAlerts(calendar, true)), [calendar]);
  const [timedReminders, setTimedReminders] = React.useState<Reminder[]>([]);
  const [allDayReminders, setAllDayReminders] = React.useState<Reminder[]>([]);

  React.useEffect(() => {
    if (!visible) return;
    setName(calendar?.name ?? '');
    const initialColor = calendar ? getCalendarColor(calendar) : CALENDAR_COLOR_PALETTE[0];
    setColor(initialColor);
    setHexInput(initialColor);
    setMoreColors(false);
    setDescription(calendar?.description ?? '');
    setTimedReminders(initialTimed);
    setAllDayReminders(initialAllDay);
    setError(null);
    setSaving(false);
  }, [visible, calendar, initialTimed, initialAllDay]);

  const pickColor = (col: string) => {
    setColor(col);
    setHexInput(col);
  };
  const hexInvalid = normalizeHexColor(hexInput) === null;

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving || hexInvalid) return;
    setSaving(true);
    setError(null);
    try {
      const values: CalendarEditValues = { name: trimmed, color, description: description.trim() };
      // Ids unique in the account: Stalwart 1.0 refuses one another calendar uses.
      if (calendar && editsDefaults && !sameReminders(timedReminders, initialTimed)) {
        values.defaultAlertsWithTime = defaultAlertsToSave(calendar, false, timedReminders, keptTimed);
      }
      if (calendar && editsDefaults && !sameReminders(allDayReminders, initialAllDay)) {
        values.defaultAlertsWithoutTime = defaultAlertsToSave(calendar, true, allDayReminders, keptAllDay);
      }
      await onSave(values);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('calendar.notifications.event_error', 'Something went wrong'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal supportedOrientations={MODAL_ORIENTATIONS} visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableWithoutFeedback accessible={false} onPress={onClose}>
        <View style={[styles.backdrop, { paddingLeft: sheetInsets.left, paddingRight: sheetInsets.right }]}>
          <TouchableWithoutFeedback accessible={false}>
            <View style={styles.sheet}>
              <Text style={styles.title}>
                {calendar
                  ? t('calendar.management.edit_calendar', 'Edit calendar')
                  : t('calendar.management.new_calendar', 'New calendar')}
              </Text>
              <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
                <Text style={styles.label}>{t('calendar.management.name', 'Name')}</Text>
                <TextInput
                  accessibilityLabel={t('calendar.management.name', 'Name')}
                  value={name}
                  onChangeText={setName}
                  placeholder={t('calendar.management.name_placeholder', 'Calendar name')}
                  placeholderTextColor={c.textMuted}
                  style={styles.input}
                  autoFocus
                />
                <Text style={styles.label}>{t('calendar.management.color', 'Color')}</Text>
                <View style={styles.paletteRow}>
                  {CALENDAR_COLOR_PALETTE.map((col) => {
                    const active = color.toLowerCase() === col.toLowerCase();
                    return (
                      <Pressable
                        key={col}
                        onPress={() => pickColor(col)}
                        style={[styles.swatch, { backgroundColor: col }, active && styles.swatchActive]}
                        accessibilityRole="radio"
                        accessibilityLabel={calendarColorName(col, t)}
                        accessibilityState={{ selected: active }}
                      >
                        {active && <Check size={12} color={c.textInverse} />}
                      </Pressable>
                    );
                  })}
                </View>
                <View style={styles.hexRow}>
                  <View style={[styles.hexPreview, { backgroundColor: hexInvalid ? 'transparent' : color }]} />
                  <TextInput
                    value={hexInput}
                    onChangeText={(v) => {
                      setHexInput(v);
                      const hex = normalizeHexColor(v);
                      if (hex) setColor(hex);
                    }}
                    placeholder="#3b82f6"
                    placeholderTextColor={c.textMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxLength={7}
                    accessibilityLabel={t('calendar.management.custom_color', 'Custom color (hex)')}
                    style={[styles.input, styles.hexInput, hexInvalid && styles.inputInvalid]}
                  />
                  <Pressable
                    onPress={() => setMoreColors((v) => !v)}
                    style={styles.moreColors}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: moreColors }}
                  >
                    <Text style={styles.moreColorsText}>
                      {moreColors
                        ? t('calendar.management.fewer_colors', 'Fewer colors')
                        : t('calendar.management.more_colors', 'More colors')}
                    </Text>
                  </Pressable>
                </View>
                {hexInvalid && (
                  <Text style={styles.error}>
                    {t('calendar.management.color_invalid', 'Enter a color as # and six hex digits, such as #3b82f6.')}
                  </Text>
                )}
                {moreColors && (
                  <View style={styles.grid}>
                    {CUSTOM_COLOR_GRID.map((row, r) => (
                      <View key={r} style={styles.gridRow}>
                        {row.map((col) => {
                          const active = color.toLowerCase() === col;
                          return (
                            <Pressable
                              key={col}
                              onPress={() => pickColor(col)}
                              style={[styles.gridSwatch, { backgroundColor: col }, active && styles.swatchActive]}
                              accessibilityRole="radio"
                              accessibilityLabel={col}
                              accessibilityState={{ selected: active }}
                            />
                          );
                        })}
                      </View>
                    ))}
                  </View>
                )}
                <Text style={styles.label}>{t('calendar.management.description', 'Description')}</Text>
                <TextInput
                  accessibilityLabel={t('calendar.management.description', 'Description')}
                  value={description}
                  onChangeText={setDescription}
                  placeholder={t('calendar.management.description_placeholder', 'Optional')}
                  placeholderTextColor={c.textMuted}
                  style={[styles.input, styles.multiline]}
                  multiline
                />
                {editsDefaults && (
                  <>
                    <Text style={styles.sectionTitle}>{t('calendar.management.default_alerts', 'Default reminders')}</Text>
                    <Text style={styles.muted}>
                      {t(
                        'calendar.management.default_alerts_hint',
                        "New events in this calendar get these reminders unless you change them in the event. Changing them here doesn't change existing events. Email reminders are sent by the mail server.",
                      )}
                    </Text>
                    <DefaultRemindersEditor
                      label={t('calendar.management.default_alerts_timed', 'Events with a time')}
                      reminders={timedReminders}
                      keptCount={Object.keys(keptTimed).length}
                      onChange={setTimedReminders}
                      styles={styles}
                      c={c}
                      t={t}
                    />
                    <DefaultRemindersEditor
                      label={t('calendar.management.default_alerts_all_day', 'All-day events')}
                      reminders={allDayReminders}
                      keptCount={Object.keys(keptAllDay).length}
                      onChange={setAllDayReminders}
                      styles={styles}
                      c={c}
                      t={t}
                    />
                  </>
                )}
                {error ? <Text style={styles.error}>{error}</Text> : null}
              </ScrollView>
              <View style={styles.footer}>
                <Button variant="outline" size="sm" onPress={onClose}>
                  {t('common.cancel', 'Cancel')}
                </Button>
                <Button
                  size="sm"
                  onPress={() => { void handleSave(); }}
                  disabled={!name.trim() || saving || hexInvalid}
                  icon={saving ? <ActivityIndicator size="small" color={c.primaryForeground} /> : undefined}
                >
                  {calendar ? t('common.save', 'Save') : t('common.create', 'Create')}
                </Button>
              </View>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: c.background,
      borderTopLeftRadius: radius.xl,
      borderTopRightRadius: radius.xl,
      padding: spacing.lg,
      paddingBottom: spacing.xxl,
      maxHeight: '85%',
      gap: spacing.md,
    },
    title: { ...typography.h3, color: c.text },
    body: { gap: spacing.sm },
    label: { ...typography.captionMedium, color: c.textSecondary, marginTop: spacing.xs },
    input: {
      minHeight: 40,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      color: c.text,
      backgroundColor: c.surface,
      ...typography.body,
    },
    multiline: { minHeight: 64, textAlignVertical: 'top' },
    paletteRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    swatch: {
      width: 28,
      height: 28,
      borderRadius: radius.full,
      alignItems: 'center',
      justifyContent: 'center',
    },
    swatchActive: { borderWidth: 2, borderColor: c.text },
    hexRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xs },
    hexPreview: { width: 28, height: 28, borderRadius: radius.full, borderWidth: 1, borderColor: c.border },
    hexInput: { flex: 1 },
    inputInvalid: { borderColor: c.error },
    moreColors: { paddingVertical: spacing.xs, paddingHorizontal: spacing.sm },
    moreColorsText: { ...typography.captionMedium, color: c.primary },
    grid: { gap: 4, marginTop: spacing.xs },
    gridRow: { flexDirection: 'row', gap: 4 },
    gridSwatch: { flex: 1, aspectRatio: 1, borderRadius: radius.sm, maxWidth: 28 },
    error: { ...typography.caption, color: c.error },
    footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.md },
    sectionTitle: { ...typography.bodyMedium, color: c.text, marginTop: spacing.md },
    muted: { ...typography.caption, color: c.textMuted },
    reminders: { gap: spacing.xs },
    reminderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      minHeight: 36,
      paddingHorizontal: spacing.md,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    reminderText: { ...typography.body, color: c.text },
    addRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.xs },
    addRowText: { ...typography.bodyMedium, color: c.primary },
    presets: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
    preset: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    presetText: { ...typography.caption, color: c.text },
  });
}
