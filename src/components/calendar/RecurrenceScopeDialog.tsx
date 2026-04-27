import React from 'react';
import { Modal, View, Text, Pressable, StyleSheet } from 'react-native';
import { Repeat, Trash2 } from 'lucide-react-native';
import { radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { Button } from '..';

export type RecurrenceEditScope = 'this' | 'this_and_future' | 'all';

interface RecurrenceScopeDialogProps {
  visible: boolean;
  actionType: 'edit' | 'delete';
  onSelect: (scope: RecurrenceEditScope) => void;
  onClose: () => void;
}

const OPTIONS: { value: RecurrenceEditScope; label: string }[] = [
  { value: 'this', label: 'This event' },
  { value: 'this_and_future', label: 'This and following events' },
  { value: 'all', label: 'All events' },
];

export function RecurrenceScopeDialog({
  visible,
  actionType,
  onSelect,
  onClose,
}: RecurrenceScopeDialogProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [selected, setSelected] = React.useState<RecurrenceEditScope>('this');
  const isDelete = actionType === 'delete';

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
                {isDelete ? 'Delete recurring event' : 'Edit recurring event'}
              </Text>
              <Text style={styles.description}>
                Choose which occurrences to {isDelete ? 'delete' : 'change'}.
              </Text>
            </View>
          </View>

          <View style={styles.options}>
            {OPTIONS.map((opt) => {
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
                  <Text style={styles.optionLabel}>{opt.label}</Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.footer}>
            <Button variant="outline" size="sm" onPress={onClose}>
              Cancel
            </Button>
            <Button
              variant={isDelete ? 'destructive' : 'default'}
              size="sm"
              onPress={() => onSelect(selected)}
            >
              {isDelete ? 'Delete' : 'Save'}
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
