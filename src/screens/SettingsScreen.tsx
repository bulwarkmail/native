import React from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, Switch } from 'react-native';
import { Settings, User, Palette, Bell, Shield, ChevronRight } from 'lucide-react-native';
import { colors } from '../theme/colors';

interface SettingItemProps {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  rightElement?: React.ReactNode;
}

function SettingItem({ icon, title, subtitle, rightElement }: SettingItemProps) {
  return (
    <Pressable style={({ pressed }) => [styles.settingRow, pressed && styles.settingRowPressed]}>
      <View style={styles.settingIcon}>{icon}</View>
      <View style={styles.settingContent}>
        <Text style={styles.settingTitle}>{title}</Text>
        {subtitle && <Text style={styles.settingSubtitle}>{subtitle}</Text>}
      </View>
      {rightElement || <ChevronRight size={18} color={colors.textMuted} />}
    </Pressable>
  );
}

export default function SettingsScreen() {
  const [darkMode, setDarkMode] = React.useState(false);
  const [notifications, setNotifications] = React.useState(true);

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Settings size={24} color={colors.primary} />
        <Text style={styles.headerTitle}>Settings</Text>
      </View>

      <View style={styles.profileCard}>
        <View style={styles.profileAvatar}>
          <Text style={styles.profileAvatarText}>B</Text>
        </View>
        <View style={styles.profileInfo}>
          <Text style={styles.profileName}>Bulwark User</Text>
          <Text style={styles.profileEmail}>user@example.com</Text>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Account</Text>
        <SettingItem
          icon={<User size={20} color={colors.primary} />}
          title="Account Settings"
          subtitle="Manage your account details"
        />
        <SettingItem
          icon={<Shield size={20} color={colors.primary} />}
          title="Privacy & Security"
          subtitle="Passwords, encryption, trusted senders"
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Preferences</Text>
        <SettingItem
          icon={<Palette size={20} color={colors.primary} />}
          title="Dark Mode"
          rightElement={<Switch value={darkMode} onValueChange={setDarkMode} trackColor={{ true: colors.primary }} />}
        />
        <SettingItem
          icon={<Bell size={20} color={colors.primary} />}
          title="Notifications"
          rightElement={<Switch value={notifications} onValueChange={setNotifications} trackColor={{ true: colors.primary }} />}
        />
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerText}>Bulwark Mobile v0.0.1</Text>
        <Text style={styles.footerText}>Built with Expo + React Native</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: 8,
  },
  headerTitle: { fontSize: 20, fontWeight: '700', color: colors.text },
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    margin: 16,
    backgroundColor: colors.surface,
    borderRadius: 12,
  },
  profileAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 16,
  },
  profileAvatarText: { fontSize: 24, fontWeight: '700', color: colors.textInverse },
  profileInfo: { flex: 1 },
  profileName: { fontSize: 18, fontWeight: '600', color: colors.text },
  profileEmail: { fontSize: 14, color: colors.textSecondary, marginTop: 2 },
  section: { marginTop: 8 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textSecondary,
    paddingHorizontal: 16,
    paddingVertical: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  settingRowPressed: { backgroundColor: colors.surfaceHover },
  settingIcon: { marginRight: 14 },
  settingContent: { flex: 1 },
  settingTitle: { fontSize: 16, color: colors.text },
  settingSubtitle: { fontSize: 13, color: colors.textSecondary, marginTop: 2 },
  footer: {
    alignItems: 'center',
    paddingVertical: 32,
    gap: 4,
  },
  footerText: { fontSize: 12, color: colors.textMuted },
});
