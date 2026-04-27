import React, { useEffect } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { SettingsSection, SettingItem } from './settings-section';
import Button from '../Button';
import { typography, spacing, radius, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSettingsStore } from '../../stores/settings-store';

export function IdentitySettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const identities = useSettingsStore((s) => s.identities);
  const loading = useSettingsStore((s) => s.loading);
  const error = useSettingsStore((s) => s.error);
  const fetchIdentities = useSettingsStore((s) => s.fetchIdentities);

  useEffect(() => {
    void fetchIdentities();
  }, [fetchIdentities]);

  const count = identities.length;
  const countLabel =
    count === 0 ? 'No identities' : count === 1 ? '1 identity' : `${count} identities`;

  return (
    <SettingsSection
      title="Identities"
      description="Manage sender names, email addresses, and signatures."
    >
      <SettingItem
        label="Identities"
        description="Your configured sender identities."
      >
        <View style={styles.row}>
          {loading ? (
            <ActivityIndicator size="small" color={c.primary} />
          ) : (
            <Text style={styles.count}>{countLabel}</Text>
          )}
        </View>
      </SettingItem>

      {error && (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {identities.map((identity) => (
        <View key={identity.id} style={styles.identityRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.identityName}>{identity.name || '(no name)'}</Text>
            <Text style={styles.identityEmail}>{identity.email}</Text>
          </View>
          {!identity.mayDelete && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>primary</Text>
            </View>
          )}
        </View>
      ))}

      <SettingItem
        label="Sub-addressing"
        description="Use plus-addressing (you+tag@example.com) to route mail."
      >
        <Button variant="outline" size="sm">Learn More</Button>
      </SettingItem>
    </SettingsSection>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  count: {
    ...typography.body,
    color: c.text,
  },
  errorBox: {
    padding: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: c.errorBg,
  },
  errorText: { ...typography.caption, color: c.error },
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: c.muted,
  },
  identityName: { ...typography.bodyMedium, color: c.text },
  identityEmail: { ...typography.caption, color: c.mutedForeground, marginTop: 2 },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.full,
    backgroundColor: 'rgba(59,130,246,0.15)',
  },
  badgeText: { fontSize: 10, fontWeight: '500', color: c.primary },
});
}
