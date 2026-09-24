import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Alert } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ArrowDown, ArrowUp, Check, ChevronRight, Plus, Star, Trash2, Users } from 'lucide-react-native';
import { SettingsSection, SettingItem } from './settings-section';
import Button from '../Button';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useAuthStore } from '../../stores/auth-store';
import { useAccountStore } from '../../stores/account-store';
import { useLocaleStore } from '../../stores/locale-store';
import { useManagedAccountStore } from '../../stores/managed-account-store';
import { setPendingSettingsTab } from '../../navigation/pending-settings-tab';
import { sharedAccountSettingsTabs } from '../../lib/capabilities';
import { jmapClient } from '../../api/jmap-client';
import { fetchMailQuota, type MailQuota } from '../../api/quota';
import { MAX_ACCOUNTS } from '../../lib/account-utils';
import type { RootStackParamList } from '../../navigation/types';

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

export function AccountSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const authUsername = useAuthStore((s) => s.username);
  const authServerUrl = useAuthStore((s) => s.serverUrl);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const session = useAuthStore((s) => s.session);
  const switchAccount = useAuthStore((s) => s.switchAccount);
  const removeAccountAuth = useAuthStore((s) => s.removeAccount);
  const accounts = useAccountStore((s) => s.accounts);
  const defaultAccountId = useAccountStore((s) => s.defaultAccountId);
  const setDefaultAccount = useAccountStore((s) => s.setDefaultAccount);
  const reorderAccounts = useAccountStore((s) => s.reorderAccounts);
  const account = accounts.find((a) => a.id === activeAccountId);

  const displayName = account?.displayName || authUsername || t('settings.account.unknown', 'Unknown');
  const email = account?.email || authUsername || '';
  const username = account?.username || authUsername || undefined;
  const serverUrl = account?.serverUrl || authServerUrl || '';
  // Live client state, not a prop: OAuth/handoff accounts carry a bearer token.
  const authMode: 'oauth' | 'basic' = jmapClient.usesBearerAuth ? 'oauth' : 'basic';

  const [quota, setQuota] = useState<MailQuota | null>(null);
  useEffect(() => {
    let cancelled = false;
    setQuota(null);
    if (!session) return;
    void fetchMailQuota().then((q) => {
      if (!cancelled) setQuota(q);
    });
    return () => { cancelled = true; };
  }, [session, activeAccountId]);

  const percent = quota && quota.total > 0 ? Math.min(100, Math.round((quota.used / quota.total) * 100)) : 0;
  const sharedAccounts = session ? jmapClient.getSharedMailAccounts() : [];
  const [busyId, setBusyId] = useState<string | null>(null);
  const setManagedAccount = useManagedAccountStore((s) => s.setManagedAccount);

  // Manage a shared/group account's filters and vacation responder: scope
  // Settings to it and open its first pane (webmail: "Shared with me").
  const manageShared = (account: { id: string; name: string }, firstTab: string) => {
    setManagedAccount(account);
    setPendingSettingsTab(firstTab);
  };

  const move = (id: string, delta: -1 | 1) => {
    const ids = accounts.map((a) => a.id);
    const idx = ids.indexOf(id);
    const target = idx + delta;
    if (idx === -1 || target < 0 || target >= ids.length) return;
    [ids[idx], ids[target]] = [ids[target], ids[idx]];
    reorderAccounts(ids);
  };

  const confirmRemove = (id: string, label: string) => {
    Alert.alert(
      t('sidebar.remove_account_title', 'Remove account?'),
      t('sidebar.remove_account_message', 'Sign out of {account} on this device. Your mail stays on the server.', { account: label }),
      [
        { text: t('common.cancel', 'Cancel'), style: 'cancel' },
        {
          text: t('common.remove', 'Remove'),
          style: 'destructive',
          onPress: () => {
            setBusyId(id);
            void removeAccountAuth(id).finally(() => setBusyId(null));
          },
        },
      ],
    );
  };

  return (
    <View style={{ gap: spacing.xxxl }}>
      <SettingsSection
        title={t('settings.account.title', 'Account')}
        description={t('settings.account.description', 'View your account information')}
      >
        <SettingItem label={t('settings.account.name_label', 'Display Name')}>
          <Text style={styles.value}>{displayName}</Text>
        </SettingItem>

        <SettingItem label={t('settings.account.email.label', 'Email Address')}>
          <Text style={styles.value}>{email}</Text>
        </SettingItem>

        {username && username !== email && (
          <SettingItem label={t('settings.account.username_label', 'Username')}>
            <Text style={styles.value}>{username}</Text>
          </SettingItem>
        )}

        <SettingItem label={t('settings.account.auth_method_label', 'Authentication')}>
          <Text style={styles.value}>
            {authMode === 'oauth'
              ? t('settings.account.auth_method_oauth', 'Single Sign-On (OAuth/OIDC)')
              : t('settings.account.auth_method_basic', 'Password')}
          </Text>
        </SettingItem>

        <SettingItem label={t('settings.account.server.label', 'JMAP Server')}>
          <Text style={styles.value} numberOfLines={1}>{serverUrl}</Text>
        </SettingItem>

        {quota && quota.total > 0 && (
          <SettingItem
            label={t('settings.account.storage.label', 'Storage Usage')}
            description={t('settings.account.storage.used', '{used} of {total} used', {
              used: formatFileSize(quota.used),
              total: formatFileSize(quota.total),
            })}
          >
            <View style={styles.storage}>
              <Text style={styles.value}>
                {t('settings.account.storage.percentage', '{percent}% used', { percent })}
              </Text>
              <View style={styles.bar} accessibilityRole="progressbar">
                <View style={[styles.barFill, { width: `${percent}%` }, percent >= 90 && styles.barFillWarn]} />
              </View>
            </View>
          </SettingItem>
        )}
      </SettingsSection>

      <SettingsSection
        title={t('settings.account.accounts.title', 'Logged-in accounts')}
        description={t('settings.account.accounts.description_mobile', 'Reorder how accounts appear in the account switcher, pick the default, or sign one out.')}
      >
        <View style={styles.list}>
          {accounts.map((a, index) => {
            const isActive = a.id === activeAccountId;
            const isDefault = a.id === defaultAccountId;
            const label = a.email || a.username;
            return (
              <View key={a.id} style={[styles.row, index > 0 && styles.rowBorder]}>
                <View style={[styles.avatar, { backgroundColor: a.avatarColor }]}>
                  <Text style={styles.avatarText}>{(a.displayName || a.username).slice(0, 1).toUpperCase()}</Text>
                </View>
                <Pressable
                  style={{ flex: 1, minWidth: 0 }}
                  onPress={() => { if (!isActive) void switchAccount(a.id); }}
                  accessibilityRole="button"
                  accessibilityLabel={isActive
                    ? t('settings.account.accounts.active', 'Currently active account')
                    : t('settings.account.accounts.switch_to', 'Switch to this account')}
                >
                  <View style={styles.rowTitle}>
                    <Text style={styles.rowName} numberOfLines={1}>{a.displayName || a.username}</Text>
                    {isActive && <Check size={14} color={c.success} />}
                  </View>
                  <Text style={styles.rowSub} numberOfLines={1}>{label}</Text>
                  {isDefault && (
                    <Text style={styles.defaultBadge}>
                      {t('settings.account.accounts.default_badge', 'Default account')}
                    </Text>
                  )}
                  {a.hasError && a.errorMessage ? (
                    <Text style={styles.rowError} numberOfLines={1}>{a.errorMessage}</Text>
                  ) : null}
                </Pressable>
                <View style={styles.rowActions}>
                  <Pressable
                    style={styles.iconBtn}
                    onPress={() => move(a.id, -1)}
                    disabled={index === 0}
                    accessibilityRole="button"
                    accessibilityLabel={t('settings.account.accounts.move_up', 'Move up')}
                  >
                    <ArrowUp size={14} color={index === 0 ? c.border : c.mutedForeground} />
                  </Pressable>
                  <Pressable
                    style={styles.iconBtn}
                    onPress={() => move(a.id, 1)}
                    disabled={index === accounts.length - 1}
                    accessibilityRole="button"
                    accessibilityLabel={t('settings.account.accounts.move_down', 'Move down')}
                  >
                    <ArrowDown size={14} color={index === accounts.length - 1 ? c.border : c.mutedForeground} />
                  </Pressable>
                  <Pressable
                    style={styles.iconBtn}
                    onPress={() => setDefaultAccount(a.id)}
                    disabled={isDefault}
                    accessibilityRole="button"
                    accessibilityLabel={t('settings.account.accounts.set_default', 'Set as default')}
                  >
                    <Star size={14} color={isDefault ? c.warning : c.mutedForeground} fill={isDefault ? c.warning : 'transparent'} />
                  </Pressable>
                  <Pressable
                    style={styles.iconBtn}
                    onPress={() => confirmRemove(a.id, label)}
                    disabled={busyId !== null}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.remove', 'Remove')}
                  >
                    <Trash2 size={14} color={c.error} />
                  </Pressable>
                </View>
              </View>
            );
          })}
        </View>
        <View style={styles.addRow}>
          <Button
            variant="outline"
            size="sm"
            icon={<Plus size={14} color={c.text} />}
            onPress={() => navigation.navigate('AddAccount')}
            disabled={accounts.length >= MAX_ACCOUNTS}
          >
            {t('settings.account.accounts.add', 'Add account')}
          </Button>
          {accounts.length >= MAX_ACCOUNTS && (
            <Text style={styles.hint}>
              {t('settings.account.accounts.limit', 'Maximum of {count} accounts reached.', { count: MAX_ACCOUNTS })}
            </Text>
          )}
        </View>
      </SettingsSection>

      {sharedAccounts.length > 0 && (
        <SettingsSection
          title={t('settings.account.shared_accounts.title', 'Shared with me')}
          description={t('settings.account.shared_accounts.description_manage', 'Group and shared accounts you can read through this account. Select one to manage its filters and vacation responder.')}
        >
          <View style={styles.list}>
            {sharedAccounts.map((s, index) => {
              const firstTab = sharedAccountSettingsTabs(s.id)[0];
              return (
                <Pressable
                  key={s.id}
                  onPress={firstTab ? () => manageShared(s, firstTab) : undefined}
                  disabled={!firstTab}
                  accessibilityRole={firstTab ? 'button' : undefined}
                  style={({ pressed }) => [
                    styles.row,
                    index > 0 && styles.rowBorder,
                    pressed && firstTab && { backgroundColor: c.muted },
                  ]}
                >
                  <View style={[styles.avatar, { backgroundColor: c.muted }]}>
                    <Users size={14} color={c.mutedForeground} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowName} numberOfLines={1}>{s.name}</Text>
                    <Text style={styles.rowSub}>{t('settings.account.shared_accounts.shared_label', 'Shared account')}</Text>
                  </View>
                  {firstTab && <ChevronRight size={16} color={c.mutedForeground} />}
                </Pressable>
              );
            })}
          </View>
        </SettingsSection>
      )}
    </View>
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
  barFillWarn: { backgroundColor: c.warning },
  list: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  rowBorder: { borderTopWidth: 1, borderTopColor: c.border },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { ...typography.bodyMedium, color: '#ffffff' },
  rowTitle: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowName: { ...typography.bodyMedium, color: c.text, flexShrink: 1 },
  rowSub: { ...typography.caption, color: c.mutedForeground },
  rowError: { ...typography.caption, color: c.error },
  defaultBadge: { ...typography.caption, color: c.primary, marginTop: 2 },
  rowActions: { flexDirection: 'row', gap: 2 },
  iconBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  addRow: { gap: spacing.sm, alignItems: 'flex-start' },
  hint: { ...typography.caption, color: c.mutedForeground },
  });
}
