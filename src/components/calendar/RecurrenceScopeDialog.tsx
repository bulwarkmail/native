import React from 'react';
import { Modal, View, Text, Pressable, StyleSheet } from 'react-native';
import { Repeat, Trash2 } from 'lucide-react-native';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { Button } from '..';

export type RecurrenceEditScope = 'this' | 'this_and_future' | 'all';

interface RecurrenceScopeDialogProps {
  visible: boolean;
  actionType: 'edit' | 'delete' | 'rsvp';
  onSelect: (scope: RecurrenceEditScope) => void;
  onClose: () => void;
}

const OPTIONS: { value: RecurrenceEditScope; key: string; fallback: string }[] = [
  { value: 'this', key: 'calendar.recurrence_scope.this_event', fallback: 'This event only' },
  { value: 'this_and_future', key: 'calendar.recurrence_scope.this_and_future', fallback: 'This and following events' },
  { value: 'all', key: 'calendar.recurrence_scope.all_events', fallback: 'All events' },
];

export function RecurrenceScopeDialog({
  visible,
  actionType,
  onSelect,
  onClose,
}: RecurrenceScopeDialogProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const [selected, setSelected] = React.useState<RecurrenceEditScope>('this');
  const isDelete = actionType === 'delete';
  const isRsvp = actionType === 'rsvp';
  // An attendee cannot split the organizer's series, so an answer covers
  // one occurrence or all of them (webmail #1086).
  const options = isRsvp ? OPTIONS.filter((opt) => opt.value !== 'this_and_future') : OPTIONS;

  React.useEffect(() => {
    if (visible) setSelected('this');
  }, [visible]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.dialog}>
          <View style={styles.header}>
            <View style={[styles.iconBadge, isDelete ? styles.iconBadgeDanger : styles.iconBadgePrimary]}>
              {isDelete ? (
                <Trash2 size={20} color={c.error} />
              ) : (
                <Repeat size={20} color={c.primary} />
              )}
            </View>
            <View style={styles.headerText}>
              <Text style={styles.title}>
                {isDelete
                  ? t('calendar.recurrence_scope.delete_title', 'Delete recurring event')
                  : isRsvp
                    ? t('calendar.recurrence_scope.rsvp_title', 'Respond to recurring event')
                    : t('calendar.recurrence_scope.edit_title', 'Edit recurring event')}
              </Text>
              <Text style={styles.description}>
                {isRsvp
                  ? t(
                    'calendar.recurrence_scope.rsvp_description',
                    'This is a recurring event. Which events does your response apply to?',
                  )
                  : t(
                    'calendar.recurrence_scope.description',
                    'This is a recurring event. Which events would you like to modify?',
                  )}
              </Text>
            </View>
          </View>

          <View style={styles.options}>
            {options.map((opt) => {
              const active = selected === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  style={[styles.option, active && styles.optionActive]}
                  onPress={() => setSelected(opt.value)}
                >
                  <View style={[styles.radio, active && styles.radioActive]}>
                    {active && <View style={styles.radioDot} />}
                  </View>
                  <Text style={styles.optionLabel}>{t(opt.key, opt.fallback)}</Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.footer}>
            <Button variant="outline" size="sm" onPress={onClose}>
              {t('calendar.recurrence_scope.cancel', 'Cancel')}
            </Button>
            <Button
              variant={isDelete ? 'destructive' : 'default'}
              size="sm"
              onPress={() => onSelect(selected)}
            >
              {isDelete
                ? t('calendar.recurrence_scope.delete', 'Delete')
                : isRsvp
                  ? t('calendar.recurrence_scope.respond', 'Respond')
                  : t('calendar.recurrence_scope.save', 'Save')}
            </Button>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  dialog: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.lg,
    padding: spacing.xxl,
    gap: spacing.lg,
  },
  header: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  iconBadge: {
    width: 40,
    height: 40,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBadgeDanger: { backgroundColor: c.errorBg },
  iconBadgePrimary: { backgroundColor: c.primaryBg },
  headerText: { flex: 1 },
  title: { ...typography.h3, color: c.text },
  description: { ...typography.body, color: c.textMuted, marginTop: 4 },
  options: { gap: spacing.xs },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  optionActive: { backgroundColor: c.primaryBg, borderColor: c.primary },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: c.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioActive: { borderColor: c.primary },
  radioDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: c.primary,
  },
  optionLabel: { ...typography.body, color: c.text, flex: 1 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.md,
  },
  });
}
