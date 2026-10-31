import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { Lock, ShieldCheck, ShieldAlert, Shield } from '../icons';
import Button from '../Button';
import { UnlockKeyDialog } from '../crypto/UnlockKeyDialog';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { useCryptoKeysStore, type CryptoKeyRecord } from '../../stores/crypto-keys-store';
import type { SecureStatus } from '../../lib/crypto/secure-message';
import { secureBannerRows, type BannerTone as Tone } from '../../lib/crypto/banner-rows';

/** Status banner above a PGP / S/MIME message, with Unlock for a locked key. */
export function SecureMessageBanner({ status, loading }: { status: SecureStatus | null; loading?: boolean }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const keys = useCryptoKeysStore((s) => s.keys);
  const [unlockRecord, setUnlockRecord] = React.useState<CryptoKeyRecord | null>(null);

  if (loading) {
    return (
      <View style={styles.row} accessibilityRole="progressbar">
        <ActivityIndicator size="small" color={c.textMuted} />
        <Text style={[styles.text, { color: c.textMuted }]}>{t('encryption.banner.checking', 'Checking encryption and signature…')}</Text>
      </View>
    );
  }
  if (!status) return null;
  const rows = secureBannerRows(status, t);
  if (rows.length === 0) return null;
  const color = (tone: Tone) => (tone === 'ok' ? c.success : tone === 'warn' ? c.warning : tone === 'error' ? c.error : c.textMuted);
  const lockedRecord = status.lockedKeyIds?.length
    ? keys.find((k) => k.kind === status.kind && status.lockedKeyIds!.includes(k.id)) ?? null
    : null;

  return (
    <View style={styles.wrap} accessibilityRole="summary">
      {rows.map((row) => {
        const Icon = row.key === 'dec' || row.key === 'locked' ? Lock : row.tone === 'ok' ? ShieldCheck : row.tone === 'muted' ? Shield : ShieldAlert;
        return (
          <View key={row.key} style={[styles.row, { borderColor: color(row.tone) }]}>
            <Icon size={16} color={color(row.tone)} />
            <Text style={[styles.text, { color: color(row.tone) }]}>{row.text}</Text>
            {row.key === 'locked' && lockedRecord && (
              <Button size="sm" variant="outline" onPress={() => setUnlockRecord(lockedRecord)}>{t('encryption.unlock', 'Unlock')}</Button>
            )}
          </View>
        );
      })}
      <UnlockKeyDialog
        record={unlockRecord}
        reason={t('encryption.unlock_read_reason', 'The message is encrypted to this key.')}
        onUnlocked={() => setUnlockRecord(null)}
        onCancel={() => setUnlockRecord(null)}
      />
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    wrap: { gap: spacing.xs, paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    text: { ...typography.caption, flex: 1 },
  });
}
