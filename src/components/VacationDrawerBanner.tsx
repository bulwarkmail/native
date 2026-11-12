import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Palmtree } from './icons';
import { spacing, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { useLocaleStore } from '../stores/locale-store';
import { useVacationStore } from '../stores/vacation-store';
import { toast } from '../stores/toast-store';
import { vacationBannerShown } from '../lib/vacation-banner';

/**
 * "Out of office is on" at the top of the mail drawer, which opens the
 * settings and has "Turn off" (webmail components/layout/sidebar.tsx
 * VacationBanner). Only for the signed-in user's own reply.
 */
export function VacationDrawerBanner({ onOpenSettings }: { onOpenSettings: () => void }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const isEnabled = useVacationStore((s) => s.isEnabled);
  const isSupported = useVacationStore((s) => s.isSupported);
  const isSaving = useVacationStore((s) => s.isSaving);
  const hasLoaded = useVacationStore((s) => s.hasLoaded);
  const accountId = useVacationStore((s) => s.accountId);
  const [turningOff, setTurningOff] = React.useState(false);

  // Settings loads the reply; the drawer needs it before that.
  React.useEffect(() => {
    const state = useVacationStore.getState();
    if (!state.hasLoaded && !state.isLoading) void state.fetch().catch(() => undefined);
  }, []);

  if (!vacationBannerShown({ isEnabled, isSupported, hasLoaded, accountId })) return null;

  // Like Gmail's "End now": off on the server, without opening Settings.
  const turnOff = async () => {
    if (turningOff) return;
    setTurningOff(true);
    try {
      await useVacationStore.getState().save({ isEnabled: false });
    } catch {
      toast.error(t('notifications.vacation_save_failed', 'Failed to save out of office settings'));
    } finally {
      setTurningOff(false);
    }
  };

  return (
    <View style={styles.row}>
      <Pressable
        style={styles.label}
        onPress={onOpenSettings}
        accessibilityRole="button"
      >
        <Palmtree size={14} color={c.warning} />
        <Text style={styles.text} numberOfLines={1}>{t('settings.filters.vacation_active', 'Out of office is on')}</Text>
      </Pressable>
      <Pressable
        style={styles.action}
        onPress={() => void turnOff()}
        disabled={turningOff || isSaving}
        accessibilityRole="button"
        hitSlop={8}
      >
        {turningOff ? <ActivityIndicator size="small" color={c.warning} /> : null}
        <Text style={styles.actionText}>{t('sidebar.vacation_turn_off', 'Turn off')}</Text>
      </Pressable>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      minHeight: 40,
      backgroundColor: c.warningBg,
    },
    label: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 40 },
    text: { ...typography.caption, color: c.warning, fontWeight: '600', flexShrink: 1 },
    action: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.sm, minHeight: 40 },
    actionText: { ...typography.caption, color: c.warning, fontWeight: '600' },
  });
}
