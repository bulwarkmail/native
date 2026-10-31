import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RotateCcw } from '../icons';
import { spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { setPendingSettingsTab } from '../../navigation/pending-settings-tab';
import { recoveryPolicy } from '../../lib/recovery/policy';
import { useRecoveryStore } from '../../lib/recovery/recovery-store';
import { recoveryClientFor, useDeletedItemsRecovery } from '../../lib/recovery/use-deleted-items-recovery';
import { isOwnTrash, trashRecoveryLinkVisible } from '../../lib/recovery/trash-link';
import type { Mailbox } from '../../api/types';
import type { RootStackParamList } from '../../navigation/types';

/**
 * A line in the Trash folder's header that leads to Settings > Recover
 * deleted items (webmail components/email/trash-recovery-link.tsx): only
 * when the server offers it for this account and its archive holds at least
 * one message inside the days window, so it never leads to an empty page.
 * Only in the account's own Trash: a shared or group Trash has an archive of
 * its own that the page doesn't show.
 */
export function TrashRecoveryLink({ mailbox }: { mailbox: Mailbox | undefined }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { available, accountId, key } = useDeletedItemsRecovery();
  const { days } = recoveryPolicy();
  const recent = useRecoveryStore((s) => (key ? s.recent[key] : undefined));
  const checkRecent = useRecoveryStore((s) => s.checkRecent);
  const ownTrash = isOwnTrash(mailbox, accountId);

  React.useEffect(() => {
    if (!available || !ownTrash || !accountId || !key) return;
    void checkRecent(recoveryClientFor(accountId), key, days);
  }, [available, ownTrash, accountId, key, days, checkRecent]);

  if (!trashRecoveryLinkVisible({ available, ownTrash, recent, days })) return null;
  const open = () => {
    setPendingSettingsTab('recovery');
    navigation.navigate('MainTabs', { screen: 'Settings' } as never);
  };
  return (
    <View style={styles.row} testID="trash-recovery-link">
      <Text style={styles.hint} numberOfLines={1}>
        {t('recover_deleted.trash_hint', 'Deleted for good by mistake?')}
      </Text>
      <Pressable onPress={open} style={styles.link} hitSlop={8} accessibilityRole="button">
        <RotateCcw size={14} color={c.primary} />
        <Text style={styles.linkText}>{t('recover_deleted.trash_link', 'Recover deleted items')}</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (c: ThemePalette) => StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  hint: { ...typography.caption, color: c.textSecondary, flex: 1, minWidth: 0 },
  link: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },
  linkText: { ...typography.captionMedium, color: c.primary },
});
