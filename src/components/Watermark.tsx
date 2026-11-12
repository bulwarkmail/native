import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useAccountStore } from '../stores/account-store';
import { useLocaleStore } from '../stores/locale-store';
import { useDevicePolicy } from '../lib/device-policy';
import { WATERMARK_COLUMNS, WATERMARK_ROWS, watermarkText } from '../lib/watermark';

/**
 * The organisation's watermark (device policy `watermark`, webmail
 * components/device/watermark.tsx): the signed-in address and today's date,
 * repeated across a message or a file preview. Put it last inside the view
 * it covers; it fills that view and lets every touch through. Hidden from
 * screen readers.
 */
export function Watermark() {
  const on = useDevicePolicy().watermark;
  const locale = useLocaleStore((s) => s.locale);
  const address = useAccountStore((s) => {
    const active = s.activeAccountId ? s.accounts.find((a) => a.id === s.activeAccountId) : undefined;
    return active?.email || active?.username || '';
  });
  const text = React.useMemo(() => (on ? watermarkText(address, new Date(), locale) : null), [on, address, locale]);
  if (!text) return null;
  return (
    <View
      style={styles.layer}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="watermark"
    >
      {Array.from({ length: WATERMARK_ROWS * WATERMARK_COLUMNS }, (_, i) => (
        <View key={i} style={styles.cell}>
          <Text style={styles.text} numberOfLines={1}>{text}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    ...StyleSheet.absoluteFillObject,
    overflow: 'hidden',
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignContent: 'space-around',
    zIndex: 6,
  },
  cell: { width: `${100 / WATERMARK_COLUMNS}%`, alignItems: 'center' },
  text: {
    transform: [{ rotate: '-30deg' }],
    fontSize: 14,
    fontWeight: '600',
    color: 'rgba(120, 120, 120, 0.22)',
    paddingVertical: 40,
    paddingHorizontal: 8,
  },
});
