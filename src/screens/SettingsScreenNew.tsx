import React from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, Switch } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  User, Mail, CalendarDays, Shield, Bell, Palette, Globe, Lock,
  ChevronRight, LogOut, Moon, Server, Key, Fingerprint, Info, HelpCircle
} from 'lucide-react-native';
import { colors, spacing, radius, typography, componentSizes } from '../theme/tokens';

interface SettingItem {
  id: string;
  icon: any;
  iconColor: string;
  iconBg: string;
  label: string;
  detail?: string;
  type: 'link' | 'toggle';
  value?: boolean;
}

const PROFILE = {
  name: 'Jane Doe',
  email: 'jane@bulwark.mail',
  plan: 'Pro',
};

const SECTIONS: { title: string; items: SettingItem[] }[] = [
  {
    title: 'Account',
    items: [
      { id: 'profile', icon: User, iconColor: colors.primary, iconBg: colors.primaryBg, label: 'Profile', detail: PROFILE.email, type: 'link' },
      { id: 'identities', icon: Mail, iconColor: colors.calendar.purple, iconBg: colors.calendar.purpleBg, label: 'Identities & Signatures', type: 'link' },
      { id: 'security', icon: Lock, iconColor: colors.error, iconBg: colors.errorBg, label: 'Security', detail: '2FA enabled', type: 'link' },
    ],
  },
  {
    title: 'Email',
    items: [
      { id: 'filters', icon: Mail, iconColor: colors.calendar.teal, iconBg: colors.calendar.tealBg, label: 'Filters & Rules', type: 'link' },
      { id: 'smime', icon: Shield, iconColor: colors.calendar.indigo, iconBg: colors.calendar.indigoBg, label: 'S/MIME Encryption', type: 'link' },
      { id: 'vacation', icon: CalendarDays, iconColor: colors.calendar.orange, iconBg: colors.warningBg, label: 'Vacation Responder', detail: 'Off', type: 'link' },
    ],
  },
  {
    title: 'Appearance',
    items: [
      { id: 'theme', icon: Palette, iconColor: colors.calendar.pink, iconBg: colors.calendar.pinkBg, label: 'Theme', detail: 'System', type: 'link' },
      { id: 'darkMode', icon: Moon, iconColor: colors.calendar.purple, iconBg: colors.calendar.purpleBg, label: 'Dark Mode', type: 'toggle', value: false },
      { id: 'language', icon: Globe, iconColor: colors.calendar.blue, iconBg: colors.primaryBg, label: 'Language', detail: 'English', type: 'link' },
    ],
  },
  {
    title: 'Notifications',
    items: [
      { id: 'pushNotif', icon: Bell, iconColor: colors.calendar.green, iconBg: colors.successBg, label: 'Push Notifications', type: 'toggle', value: true },
      { id: 'emailNotif', icon: Mail, iconColor: colors.primary, iconBg: colors.primaryBg, label: 'Email Notifications', type: 'toggle', value: true },
    ],
  },
  {
    title: 'Advanced',
    items: [
      { id: 'server', icon: Server, iconColor: colors.textMuted, iconBg: colors.surface, label: 'Server Settings', type: 'link' },
      { id: 'privacy', icon: Fingerprint, iconColor: colors.textSecondary, iconBg: colors.surface, label: 'Privacy', type: 'link' },
      { id: 'about', icon: Info, iconColor: colors.textMuted, iconBg: colors.surface, label: 'About', detail: 'v1.0.0', type: 'link' },
      { id: 'help', icon: HelpCircle, iconColor: colors.textMuted, iconBg: colors.surface, label: 'Help & Support', type: 'link' },
    ],
  },
];

function SettingRow({ item }: { item: SettingItem }) {
  const Icon = item.icon;
  const [toggled, setToggled] = React.useState(item.value ?? false);

  return (
    <Pressable
      style={({ pressed }) => [styles.settingRow, pressed && item.type === 'link' && styles.settingRowPressed]}
    >
      <View style={[styles.settingIcon, { backgroundColor: item.iconBg }]}>
        <Icon size={18} color={item.iconColor} />
      </View>
      <View style={styles.settingContent}>
        <Text style={styles.settingLabel}>{item.label}</Text>
        {item.detail && item.type === 'link' && (
          <Text style={styles.settingDetail}>{item.detail}</Text>
        )}
      </View>
      {item.type === 'link' && (
        <ChevronRight size={18} color={colors.textMuted} />
      )}
      {item.type === 'toggle' && (
        <Switch
          value={toggled}
          onValueChange={setToggled}
          trackColor={{ false: colors.surface, true: colors.primary }}
          thumbColor={colors.background}
        />
      )}
    </Pressable>
  );
}

interface SettingsScreenProps {
  onLogout?: () => void;
}

export default function SettingsScreen({ onLogout }: SettingsScreenProps) {
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Profile card */}
        <View style={styles.profileCard}>
          <View style={styles.profileAvatar}>
            <Text style={styles.profileAvatarText}>JD</Text>
          </View>
          <View style={styles.profileInfo}>
            <Text style={styles.profileName}>{PROFILE.name}</Text>
            <Text style={styles.profileEmail}>{PROFILE.email}</Text>
          </View>
          <View style={styles.planBadge}>
            <Text style={styles.planBadgeText}>{PROFILE.plan}</Text>
          </View>
        </View>

        {/* Settings sections */}
        {SECTIONS.map(section => (
          <View key={section.title} style={styles.section}>
            <Text style={styles.sectionTitle}>{section.title}</Text>
            <View style={styles.sectionCard}>
              {section.items.map((item, idx) => (
                <React.Fragment key={item.id}>
                  {idx > 0 && <View style={styles.sectionSeparator} />}
                  <SettingRow item={item} />
                </React.Fragment>
              ))}
            </View>
          </View>
        ))}

        {/* Sign out */}
        <Pressable style={styles.signOutBtn} onPress={onLogout}>
          <LogOut size={18} color={colors.error} />
          <Text style={styles.signOutText}>Sign Out</Text>
        </Pressable>

        {/* Version info */}
        <Text style={styles.versionText}>Bulwark Mobile v0.0.1</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  scrollContent: { paddingBottom: 40 },

  // Profile card
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: spacing.lg,
    padding: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    gap: spacing.md,
  },
  profileAvatar: {
    width: componentSizes.avatarLg, height: componentSizes.avatarLg,
    borderRadius: componentSizes.avatarLg / 2,
    backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  profileAvatarText: { ...typography.h3, color: colors.textInverse },
  profileInfo: { flex: 1 },
  profileName: { ...typography.bodyMedium, color: colors.text },
  profileEmail: { ...typography.caption, color: colors.textMuted, marginTop: 2 },
  planBadge: {
    backgroundColor: colors.primaryBg,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.full,
  },
  planBadgeText: { ...typography.small, color: colors.primary },

  // Sections
  section: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.xl,
  },
  sectionTitle: {
    ...typography.small,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
    marginLeft: spacing.xs,
  },
  sectionCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  sectionSeparator: {
    height: 1,
    backgroundColor: colors.borderLight,
    marginLeft: 56,
  },

  // Setting row
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  settingRowPressed: { backgroundColor: colors.surfaceHover },
  settingIcon: {
    width: 32, height: 32,
    borderRadius: radius.sm,
    alignItems: 'center', justifyContent: 'center',
  },
  settingContent: { flex: 1 },
  settingLabel: { ...typography.body, color: colors.text },
  settingDetail: { ...typography.small, color: colors.textMuted, marginTop: 1 },

  // Sign out
  signOutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.errorBorder,
    backgroundColor: colors.errorBg,
  },
  signOutText: { ...typography.bodyMedium, color: colors.error },

  // Version
  versionText: {
    ...typography.small,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.xl,
    marginBottom: spacing.lg,
  },
});
