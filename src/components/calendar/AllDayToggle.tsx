import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { ChevronDown, ChevronUp } from '../icons';
import { typography } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';

interface Props {
  /** Rows the collapsed area leaves out. */
  hiddenRows: number;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * Under the "All day" label of the week and day grids: "+N" opens the rows
 * past the first three, and closes them again (webmail calendar-week-view,
 * #1122).
 */
export function AllDayToggle({ hiddenRows, expanded, onToggle }: Props) {
  const c = useColors();
  const t = useLocaleStore((s) => s.t);
  return (
    <Pressable
      onPress={onToggle}
      hitSlop={8}
      style={styles.button}
      accessibilityRole="button"
      accessibilityLabel={expanded ? t('calendar.events.show_less', 'Show less') : t('calendar.events.show_more', 'Show more')}
      accessibilityState={{ expanded }}
    >
      {expanded ? null : <Text style={[styles.count, { color: c.textMuted }]}>+{hiddenRows}</Text>}
      {expanded ? <ChevronUp size={12} color={c.textMuted} /> : <ChevronDown size={12} color={c.textMuted} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { flexDirection: 'row', alignItems: 'center', gap: 1, marginTop: 'auto', paddingVertical: 2 },
  count: { ...typography.small },
});
