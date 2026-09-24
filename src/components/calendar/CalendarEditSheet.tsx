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
import { Check } from 'lucide-react-native';
import type { Calendar } from '../../api/types';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { CALENDAR_COLOR_PALETTE, calendarColorName, getCalendarColor } from '../../lib/calendar-utils';
import Button from '../Button';

export interface CalendarEditValues {
  name: string;
  color: string;
  description: string;
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
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const [name, setName] = React.useState('');
  const [color, setColor] = React.useState<string>(CALENDAR_COLOR_PALETTE[0]);
  const [description, setDescription] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!visible) return;
    setName(calendar?.name ?? '');
    setColor(calendar ? getCalendarColor(calendar) : CALENDAR_COLOR_PALETTE[0]);
    setDescription(calendar?.description ?? '');
    setError(null);
    setSaving(false);
  }, [visible, calendar]);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ name: trimmed, color, description: description.trim() });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('calendar.notifications.event_error', 'Something went wrong'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop}>
          <TouchableWithoutFeedback>
            <View style={styles.sheet}>
              <Text style={styles.title}>
                {calendar
                  ? t('calendar.management.edit_calendar', 'Edit calendar')
                  : t('calendar.management.new_calendar', 'New calendar')}
              </Text>
              <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body}>
                <Text style={styles.label}>{t('calendar.management.name', 'Name')}</Text>
                <TextInput
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
                        onPress={() => setColor(col)}
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
                <Text style={styles.label}>{t('calendar.management.description', 'Description')}</Text>
                <TextInput
                  value={description}
                  onChangeText={setDescription}
                  placeholder={t('calendar.management.description_placeholder', 'Optional')}
                  placeholderTextColor={c.textMuted}
                  style={[styles.input, styles.multiline]}
                  multiline
                />
                {error ? <Text style={styles.error}>{error}</Text> : null}
              </ScrollView>
              <View style={styles.footer}>
                <Button variant="outline" size="sm" onPress={onClose}>
                  {t('common.cancel', 'Cancel')}
                </Button>
                <Button
                  size="sm"
                  onPress={() => { void handleSave(); }}
                  disabled={!name.trim() || saving}
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
    error: { ...typography.caption, color: c.error },
    footer: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.md },
  });
}
