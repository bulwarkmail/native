import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Key, Smartphone, Lock, Eye, EyeOff, Shield, Monitor, Trash2 } from 'lucide-react-native';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import Input from '../Input';
import Button from '../Button';
import { colors, spacing, radius, typography } from '../../theme/tokens';

interface Session {
  id: string;
  device: string;
  location: string;
  current: boolean;
}

const MOCK_SESSIONS: Session[] = [
  { id: '1', device: 'iPhone 15 Pro - Bulwark Mobile', location: 'Berlin, DE', current: true },
  { id: '2', device: 'Chrome on macOS', location: 'Berlin, DE', current: false },
];

export function AccountSecuritySettings() {
  const [currentPwd, setCurrentPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [twoFactor, setTwoFactor] = useState(false);
  const [appPwds] = useState<{ id: string; label: string; created: string }[]>([]);

  return (
    <View style={styles.container}>
      <SettingsSection title="Password" description="Change the password for this account.">
        <View style={{ gap: spacing.md }}>
          <View style={styles.pwField}>
            <Text style={styles.pwLabel}>Current password</Text>
            <View style={styles.pwInputRow}>
              <Input
                value={currentPwd}
                onChangeText={setCurrentPwd}
                secureTextEntry={!showCurrent}
                containerStyle={{ flex: 1 }}
              />
              <Pressable style={styles.eyeBtn} onPress={() => setShowCurrent((v) => !v)}>
                {showCurrent ? (
                  <EyeOff size={16} color={colors.mutedForeground} />
                ) : (
                  <Eye size={16} color={colors.mutedForeground} />
                )}
              </Pressable>
            </View>
          </View>

          <View style={styles.pwField}>
            <Text style={styles.pwLabel}>New password</Text>
            <View style={styles.pwInputRow}>
              <Input
                value={newPwd}
                onChangeText={setNewPwd}
                secureTextEntry={!showNew}
                containerStyle={{ flex: 1 }}
              />
              <Pressable style={styles.eyeBtn} onPress={() => setShowNew((v) => !v)}>
                {showNew ? (
                  <EyeOff size={16} color={colors.mutedForeground} />
                ) : (
                  <Eye size={16} color={colors.mutedForeground} />
                )}
              </Pressable>
            </View>
          </View>

          <View style={styles.pwField}>
            <Text style={styles.pwLabel}>Confirm password</Text>
            <Input
              value={confirmPwd}
              onChangeText={setConfirmPwd}
              secureTextEntry={!showNew}
            />
          </View>

          <View style={{ alignItems: 'flex-end' }}>
            <Button size="sm" icon={<Key size={14} color={colors.primaryForeground} />}>
              Change Password
            </Button>
          </View>
        </View>
      </SettingsSection>

      <SettingsSection title="Two-Factor Authentication" description="Add an extra layer of security with an authenticator app.">
        <SettingItem label="Enable 2FA" description="Require a one-time code at login.">
          <ToggleSwitch checked={twoFactor} onChange={setTwoFactor} />
        </SettingItem>

        {twoFactor && (
          <View style={styles.infoBox}>
            <Smartphone size={16} color={colors.primary} />
            <Text style={styles.infoText}>
              Scan the QR code in your authenticator app to finish setup.
            </Text>
          </View>
        )}
      </SettingsSection>

      <SettingsSection title="App Passwords" description="Generate passwords for other mail clients.">
        {appPwds.length === 0 ? (
          <View style={styles.empty}>
            <Lock size={24} color={colors.mutedForeground} />
            <Text style={styles.emptyText}>No app passwords yet.</Text>
          </View>
        ) : null}
        <View style={{ alignItems: 'flex-start' }}>
          <Button variant="outline" size="sm">
            Generate New
          </Button>
        </View>
      </SettingsSection>

      <SettingsSection title="Active Sessions" description="Devices currently signed into your account.">
        {MOCK_SESSIONS.map((s) => (
          <View key={s.id} style={styles.sessionRow}>
            <View style={styles.sessionIcon}>
              <Monitor size={18} color={colors.text} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.sessionDevice}>{s.device}</Text>
              <Text style={styles.sessionMeta}>
                {s.location} · {s.current ? 'Current' : 'Active'}
              </Text>
            </View>
            {!s.current && (
              <Pressable style={styles.trashBtn}>
                <Trash2 size={16} color={colors.error} />
              </Pressable>
            )}
          </View>
        ))}
      </SettingsSection>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xxxl },
  pwField: { gap: 4 },
  pwLabel: { ...typography.caption, color: colors.mutedForeground },
  pwInputRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  eyeBtn: { padding: spacing.sm },
  infoBox: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.primaryBg,
    borderRadius: radius.sm,
    alignItems: 'center',
  },
  infoText: {
    ...typography.caption,
    color: colors.primary,
    flex: 1,
  },
  empty: {
    alignItems: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
  },
  emptyText: {
    ...typography.body,
    color: colors.mutedForeground,
  },
  sessionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  sessionIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sessionDevice: { ...typography.bodyMedium, color: colors.text },
  sessionMeta: { ...typography.caption, color: colors.mutedForeground, marginTop: 2 },
  trashBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
});
