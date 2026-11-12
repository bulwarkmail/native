import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Tag } from '../icons';
import { radius, spacing, typography } from '../../theme/tokens';
import { useLocaleStore } from '../../stores/locale-store';
import { usePolicyStore } from '../../stores/policy-store';
import { labelsPolicyOf, receivedLabel, textColorOn, type HeaderSource } from '../../lib/classification-labels';

/**
 * The classification label a received message carries, when it is one of
 * the organisation's labels (webmail received-label-chip.tsx): its
 * SIO-Label marking, else the admin's extra header. Information only:
 * anyone can write the header, so nothing is relaxed because of it.
 */
export function ReceivedLabelChip({ headers }: { headers: HeaderSource }) {
  const t = useLocaleStore((s) => s.t);
  const organisation = usePolicyStore((s) => s.effective?.organisation);
  const labels = React.useMemo(() => labelsPolicyOf(organisation), [organisation]);
  const label = React.useMemo(() => receivedLabel(headers, labels), [headers, labels]);
  if (!label) return null;
  const name = t('classification.chip_label', 'Classification: {name}', { name: label.name });
  const color = textColorOn(label.color);
  return (
    <View
      style={[styles.chip, { backgroundColor: label.color }]}
      accessible
      accessibilityLabel={`${name}. ${t('classification.received_hint', "Set by the sender's mail program. Anyone can set a label, so it proves nothing.")}`}
      testID="received-label-chip"
    >
      <Tag size={11} color={color} />
      <Text style={[styles.text, { color }]} numberOfLines={1}>{label.name}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    maxWidth: '100%',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
    marginTop: 4,
  },
  text: { ...typography.small, fontWeight: '500', flexShrink: 1 },
});
