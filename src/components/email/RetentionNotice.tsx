import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Clock } from '../icons';
import { spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { useAccountOrganisation } from '../../lib/account-organisation';
import { retentionDays } from '../../lib/retention';

/**
 * How long the server keeps mail in Trash and Junk (webmail
 * components/email/retention-notice.tsx): the days the admin set in
 * Organisation > Notices (policy.json `organisation.retention`). A normal
 * user can't read Stalwart's own value, so the admin's number is the only
 * source. Nothing in other folders, or when the admin set none.
 */
export function RetentionNotice({ role }: { role: string | null | undefined }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const days = retentionDays(useAccountOrganisation().retention, role);
  if (days <= 0) return null;
  return (
    <View style={styles.row} testID="retention-notice">
      <Clock size={14} color={c.textSecondary} />
      <Text style={styles.text}>
        {t('retention_notice.line', 'Messages here are deleted {count, plural, one {# day} other {# days}} after they were moved here.', { count: days })}
      </Text>
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
  text: { ...typography.caption, color: c.textSecondary, flex: 1, minWidth: 0 },
});
