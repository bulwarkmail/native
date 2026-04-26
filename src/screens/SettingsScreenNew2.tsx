import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ArrowLeft, LogOut, Settings, ChevronRight,
  Palette, Mail, User, Shield, UserPen, Palmtree, Calendar,
  Filter, FileText, FolderOpen, Tags, HardDrive, Wrench,
  BookUser, KeyRound, PanelLeftClose, Bell, Puzzle, RefreshCw,
  type LucideIcon,
} from 'lucide-react-native';
import { colors, spacing, radius, typography, componentSizes } from '../theme/tokens';
import { EmailSettings } from '../components/settings/EmailSettings';
import { NotificationSettings } from '../components/settings/NotificationSettings';
import { AccountSettings } from '../components/settings/AccountSettings';
import { IdentitySettings } from '../components/settings/IdentitySettings';
import { VacationSettings } from '../components/settings/VacationSettings';
import { FolderSettings } from '../components/settings/FolderSettings';
import { AdvancedSettings } from '../components/settings/AdvancedSettings';
import { UpdatesSettings } from '../components/settings/UpdatesSettings';

type Tab =
  | 'appearance' | 'email' | 'notifications'
  | 'account' | 'security' | 'identities' | 'encryption' | 'vacation'
  | 'filters' | 'templates' | 'folders' | 'keywords'
  | 'calendar' | 'contacts' | 'files' | 'sidebar_apps'
  | 'themes' | 'plugins' | 'updates' | 'advanced';

type TabGroup = 'general' | 'account' | 'organization' | 'apps' | 'system';

interface TabDef {
  id: Tab;
  label: string;
  icon: LucideIcon;
  group: TabGroup;
  experimental?: boolean;
  implemented: boolean;
}

const GROUP_LABELS: Record<TabGroup, string> = {
  general: 'General',
  account: 'Account',
  organization: 'Organization',
  apps: 'Apps',
  system: 'System',
};

const GROUP_ORDER: TabGroup[] = ['general', 'account', 'organization', 'apps', 'system'];

const TABS: TabDef[] = [
  { id: 'appearance',   label: 'Appearance',            icon: Palette,        group: 'general',      implemented: false },
  { id: 'email',        label: 'Email',                 icon: Mail,           group: 'general',      implemented: true },
  { id: 'notifications',label: 'Notifications',         icon: Bell,           group: 'general',      implemented: true },
  { id: 'account',      label: 'Account',               icon: User,           group: 'account',      implemented: true },
  { id: 'security',     label: 'Security',              icon: Shield,         group: 'account',      implemented: false },
  { id: 'identities',   label: 'Identities',            icon: UserPen,        group: 'account',      implemented: true },
  { id: 'encryption',   label: 'S/MIME Encryption',     icon: KeyRound,       group: 'account',      implemented: false },
  { id: 'vacation',     label: 'Vacation Responder',    icon: Palmtree,       group: 'account',      implemented: true },
  { id: 'filters',      label: 'Filters & Rules',       icon: Filter,         group: 'organization', implemented: false },
  { id: 'templates',    label: 'Templates',             icon: FileText,       group: 'organization', implemented: false },
  { id: 'folders',      label: 'Folders',               icon: FolderOpen,     group: 'organization', implemented: true },
  { id: 'keywords',     label: 'Keywords & Labels',     icon: Tags,           group: 'organization', implemented: false },
  { id: 'calendar',     label: 'Calendar',              icon: Calendar,       group: 'apps',         implemented: false },
  { id: 'contacts',     label: 'Contacts',              icon: BookUser,       group: 'apps',         implemented: false },
  { id: 'files',        label: 'Files',                 icon: HardDrive,      group: 'apps',         implemented: false },
  { id: 'sidebar_apps', label: 'Sidebar Apps',          icon: PanelLeftClose, group: 'apps',         implemented: false },
  { id: 'themes',       label: 'Themes',                icon: Palette,        group: 'system',       experimental: true, implemented: false },
  { id: 'plugins',      label: 'Plugins',               icon: Puzzle,         group: 'system',       experimental: true, implemented: false },
  { id: 'updates',      label: 'Updates',               icon: RefreshCw,      group: 'system',       implemented: true },
  { id: 'advanced',     label: 'Advanced',              icon: Wrench,         group: 'system',       implemented: true },
];

const TAB_COMPONENTS: Partial<Record<Tab, React.ComponentType<any>>> = {
  email: EmailSettings,
  notifications: NotificationSettings,
  account: AccountSettings,
  identities: IdentitySettings,
  vacation: VacationSettings,
  folders: FolderSettings,
  updates: UpdatesSettings,
  advanced: AdvancedSettings,
};

function groupTabs() {
  return GROUP_ORDER.map(group => ({
    group,
    label: GROUP_LABELS[group],
    items: TABS.filter(t => t.group === group),
  })).filter(g => g.items.length > 0);
}

interface SettingsScreenProps {
  onLogout?: () => void;
  onBack?: () => void;
  onTabSelect?: (tab: Tab) => void;
}

export default function SettingsScreen({ onLogout, onBack, onTabSelect }: SettingsScreenProps) {
  const [selectedTab, setSelectedTab] = useState<Tab | null>(null);
  const groupedTabs = groupTabs();

  const handleTabPress = (tab: TabDef) => {
    if (!tab.implemented) return;
    setSelectedTab(tab.id);
    onTabSelect?.(tab.id);
  };

  if (selectedTab) {
    const tabDef = TABS.find(t => t.id === selectedTab)!;
    const Component = TAB_COMPONENTS[selectedTab];
    const TabIcon = tabDef.icon;

    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <Pressable
            onPress={() => setSelectedTab(null)}
            style={({ pressed }) => [styles.headerBackBtn, pressed && styles.headerBackBtnPressed]}
          >
            <ArrowLeft size={20} color={colors.text} />
          </Pressable>
          <TabIcon size={20} color={colors.mutedForeground} />
          <Text style={styles.headerTitle}>{tabDef.label}</Text>
        </View>

        <ScrollView style={styles.scrollArea} contentContainerStyle={styles.detailContent}>
          {Component ? <Component /> : null}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header — matches webmail mobile: h-14, border-b, back button + icon + title */}
      <View style={styles.header}>
        <Pressable
          onPress={onBack}
          style={({ pressed }) => [styles.headerBackBtn, pressed && styles.headerBackBtnPressed]}
        >
          <ArrowLeft size={20} color={colors.text} />
        </Pressable>
        <Settings size={20} color={colors.mutedForeground} />
        <Text style={styles.headerTitle}>Settings</Text>
      </View>

      {/* Tab list — matches webmail mobile: flat grouped list, no cards */}
      <ScrollView style={styles.scrollArea} contentContainerStyle={styles.scrollContent}>
        <View style={styles.tabList}>
          {groupedTabs.map((group, groupIndex) => (
            <View key={group.group}>
              {groupIndex > 0 && <View style={styles.groupDivider} />}

              <View style={styles.groupHeader}>
                <Text style={styles.groupLabel}>{group.label}</Text>
              </View>

              {group.items.map((tab) => {
                const Icon = tab.icon;
                const disabled = !tab.implemented;
                return (
                  <Pressable
                    key={tab.id}
                    onPress={() => handleTabPress(tab)}
                    disabled={disabled}
                    style={({ pressed }) => [
                      styles.tabItem,
                      disabled && styles.tabItemDisabled,
                      !disabled && pressed && styles.tabItemPressed,
                    ]}
                  >
                    <View style={styles.tabItemLeft}>
                      <Icon size={16} color={colors.mutedForeground} />
                      <Text
                        style={[
                          styles.tabItemLabel,
                          disabled && styles.tabItemLabelDisabled,
                        ]}
                      >
                        {tab.label}
                      </Text>
                      {tab.experimental && !disabled && (
                        <View style={styles.experimentalBadge}>
                          <Text style={styles.experimentalText}>Experimental</Text>
                        </View>
                      )}
                    </View>
                    {disabled ? (
                      <View style={styles.notWorkingBadge}>
                        <Text style={styles.notWorkingText}>Not implemented</Text>
                      </View>
                    ) : (
                      <ChevronRight size={16} color={colors.mutedForeground} />
                    )}
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>

        {/* Logout — matches webmail: border-t, destructive text, icon + label */}
        <View style={styles.logoutSection}>
          <Pressable
            onPress={onLogout}
            style={({ pressed }) => [styles.logoutBtn, pressed && styles.logoutBtnPressed]}
          >
            <LogOut size={16} color={colors.error} />
            <Text style={styles.logoutText}>Sign Out</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },

  // Header — webmail: h-14, px-4, border-b, flex items-center gap-2
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    height: componentSizes.headerHeight,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  headerBackBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
  },
  headerBackBtnPressed: {
    backgroundColor: colors.accent,
  },
  headerTitle: {
    ...typography.h3,
    color: colors.text,
  },

  scrollArea: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 40,
  },
  detailContent: {
    padding: spacing.lg,
    paddingBottom: 40,
  },

  tabList: {
    paddingVertical: spacing.sm,
  },

  // Group divider — webmail: mx-5 my-2 border-t border-border
  groupDivider: {
    height: 1,
    backgroundColor: colors.border,
    marginHorizontal: 20,
    marginVertical: spacing.sm,
  },

  // Group header — webmail: px-5 pt-3 pb-1.5
  groupHeader: {
    paddingHorizontal: 20,
    paddingTop: spacing.md,
    paddingBottom: 6,
  },
  groupLabel: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    color: colors.mutedForeground,
  },

  // Tab item — webmail: px-5 py-3.5, icon w-4 h-4 text-muted-foreground, gap-3, ChevronRight
  tabItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  tabItemPressed: {
    backgroundColor: colors.muted,
  },
  tabItemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    flex: 1,
  },
  tabItemLabel: {
    ...typography.body,
    color: colors.text,
  },

  // Experimental badge — webmail: text-[10px] rounded-full bg-warning/15 text-warning
  experimentalBadge: {
    backgroundColor: 'rgba(202, 138, 4, 0.15)',
    borderRadius: radius.full,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  experimentalText: {
    fontSize: 10,
    fontWeight: '500',
    color: colors.warning,
  },

  tabItemDisabled: {
    opacity: 0.55,
  },
  tabItemLabelDisabled: {
    color: colors.mutedForeground,
  },
  notWorkingBadge: {
    backgroundColor: colors.muted,
    borderRadius: radius.full,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  notWorkingText: {
    fontSize: 10,
    fontWeight: '500',
    color: colors.mutedForeground,
  },

  // Logout — webmail: border-t border-border, px-5 py-3, destructive text
  logoutSection: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: 20,
    paddingVertical: spacing.md,
  },
  logoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: 10,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.sm,
  },
  logoutBtnPressed: {
    backgroundColor: colors.muted,
  },
  logoutText: {
    ...typography.body,
    color: colors.error,
  },
});
