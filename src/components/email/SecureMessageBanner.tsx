import React from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { Lock, ShieldCheck, ShieldAlert, Shield } from '../icons';
import Button from '../Button';
import { UnlockKeyDialog } from '../crypto/UnlockKeyDialog';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { useCryptoKeysStore, type CryptoKeyRecord } from '../../stores/crypto-keys-store';
import type { OfferedPgpKey, SecureStatus } from '../../lib/crypto/secure-message';
import { offeredKeyRow, secureBannerRows, type BannerTone as Tone } from '../../lib/crypto/banner-rows';
import { savePgpKeyFor } from '../../lib/crypto/keyring';
import { toast } from '../../stores/toast-store';

/**
 * Status banner above a PGP / S/MIME message, with Unlock for a locked key
 * and Save for a public key the message carries for its sender.
 */
export function SecureMessageBanner({ status, loading, offeredKey }: { status: SecureStatus | null; loading?: boolean; offeredKey?: OfferedPgpKey }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const keys = useCryptoKeysStore((s) => s.keys);
  const [unlockRecord, setUnlockRecord] = React.useState<CryptoKeyRecord | null>(null);
  const [saving, setSaving] = React.useState(false);

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
  const color = (tone: Tone) => (tone === 'ok' ? c.success : tone === 'warn' ? c.warning : tone === 'error' ? c.error : c.textMuted);
  const lockedRecord = status.lockedKeyIds?.length
    ? keys.find((k) => k.kind === status.kind && status.lockedKeyIds!.includes(k.id)) ?? null
    : null;
  const offer = offeredKeyRow(offeredKey, keys, t);
  if (rows.length === 0 && !offer) return null;
  const saveOffered = async () => {
    if (!offeredKey) return;
    setSaving(true);
    try {
      await savePgpKeyFor(offeredKey.armored, offeredKey.email);
    } catch (err) {
      toast.error(t('encryption.banner.save_key_failed', 'Could not save the key'), { message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

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
      {offer && (
        <View style={[styles.row, { borderColor: c.border }]}>
          <Shield size={16} color={c.textMuted} />
          <Text style={[styles.text, { color: c.textMuted }]}>{offer.text}</Text>
          <Button size="sm" variant="outline" disabled={saving} onPress={() => { void saveOffered(); }}>{offer.action}</Button>
        </View>
      )}
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
