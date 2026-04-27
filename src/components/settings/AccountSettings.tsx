import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { SettingsSection, SettingItem } from './settings-section';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useAuthStore } from '../../stores/auth-store';
import { useAccountStore } from '../../stores/account-store';

interface AccountSettingsProps {
  displayName?: string;
  email?: string;
  username?: string;
  serverUrl?: string;
  authMode?: 'oauth' | 'basic';
  quotaUsed?: number;
  quotaTotal?: number;
  isDemoMode?: boolean;
}

function formatFileSize(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function AccountSettings(props: AccountSettingsProps = {}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const authUsername = useAuthStore((s) => s.username);
  const authServerUrl = useAuthStore((s) => s.serverUrl);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const account = useAccountStore((s) =>
    activeAccountId ? s.accounts.find((a) => a.id === activeAccountId) : undefined,
  );

  const displayName = props.displayName ?? account?.displayName ?? authUsername ?? 'Unknown';
  const email = props.email ?? account?.email ?? authUsername ?? '';
  const username = props.username ?? account?.username ?? authUsername ?? undefined;
  const serverUrl = props.serverUrl ?? account?.serverUrl ?? authServerUrl ?? '';
  const authMode = props.authMode ?? 'basic';
  const quotaUsed = props.quotaUsed ?? 0;
  const quotaTotal = props.quotaTotal ?? 0;
  const isDemoMode = props.isDemoMode ?? false;

  const percent = quotaTotal ? Math.round((quotaUsed / quotaTotal) * 100) : 0;

  return (
    <SettingsSection title="Account" description="Your account information.">
      <SettingItem label="Display Name">
        <Text style={styles.value}>{displayName}</Text>
      </SettingItem>

      <SettingItem label="Email Address">
        <Text style={styles.value}>{email}</Text>
      </SettingItem>

      {username && username !== email && (
        <SettingItem label="Username">
          <Text style={styles.value}>{username}</Text>
        </SettingItem>
      )}

      <SettingItem label="Authentication">
        <Text style={styles.value}>
          {authMode === 'oauth' ? 'OAuth' : 'Basic'}
        </Text>
      </SettingItem>

      <SettingItem label="Server">
        <Text style={styles.value} numberOfLines={1}>{serverUrl}</Text>
      </SettingItem>

      {quotaTotal > 0 && (
        <SettingItem
          label="Storage"
          description={`${formatFileSize(quotaUsed)} of ${formatFileSize(quotaTotal)} used`}
        >
          <View style={styles.storage}>
            <Text style={styles.value}>{percent}%</Text>
            <View style={styles.bar}>
              <View style={[styles.barFill, { width: `${percent}%` }]} />
            </View>
          </View>
        </SettingItem>
      )}

      {isDemoMode && (
        <SettingItem label="Account Type">
          <View style={styles.demoRow}>
            <View style={styles.demoDot} />
            <Text style={styles.demoText}>Demo account</Text>
          </View>
        </SettingItem>
      )}
    </SettingsSection>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  value: {
    ...typography.body,
    color: c.text,
    maxWidth: 240,
  },
  storage: {
    alignItems: 'flex-end',
    gap: 6,
  },
  bar: {
    width: 128,
    height: 8,
    backgroundColor: c.muted,
    borderRadius: radius.full,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    backgroundColor: c.primary,
    borderRadius: radius.full,
  },
  demoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  demoDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#f59e0b',
  },
  demoText: {
    ...typography.bodyMedium,
    color: '#fbbf24',
  },
});
}
