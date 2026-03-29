import React from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ArrowLeft, ChevronRight, LogOut, Settings,
  Palette, Mail, User, Shield, UserPen, Palmtree, Calendar,
  Filter, FileText, FolderOpen, Tags, HardDrive, Wrench,
  BookUser, KeyRound, PanelLeftClose, Bell, Puzzle,
  type LucideIcon,
} from 'lucide-react-native';
import { colors, spacing, radius, typography, componentSizes } from '../theme/tokens';

type Tab =
  | 'appearance' | 'email' | 'notifications'
  | 'account' | 'security' | 'identities' | 'encryption' | 'vacation'
  | 'filters' | 'templates' | 'folders' | 'keywords'
  | 'calendar' | 'contacts' | 'files' | 'sidebar_apps'
  | 'themes' | 'plugins' | 'advanced';

type TabGroup = 'general' | 'account' | 'organization' | 'apps' | 'system';

interface TabDef {
  id: Tab;
  label: string;
  icon: LucideIcon;
  group: TabGroup;
  experimental?: boolean;
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
  { id: 'appearance',   label: 'Appearance',            icon: Palette,        group: 'general' },
  { id: 'email',        label: 'Email',                 icon: Mail,           group: 'general' },
  { id: 'notifications',label: 'Notifications',         icon: Bell,           group: 'general' },
  { id: 'account',      label: 'Account',               icon: User,           group: 'account' },
  { id: 'security',     label: 'Security',              icon: Shield,         group: 'account' },
  { id: 'identities',   label: 'Identities',            icon: UserPen,        group: 'account' },
  { id: 'encryption',   label: 'S/MIME Encryption',     icon: KeyRound,       group: 'account' },
  { id: 'vacation',     label: 'Vacation Responder',    icon: Palmtree,       group: 'account' },
  { id: 'filters',      label: 'Filters & Rules',       icon: Filter,         group: 'organization' },
  { id: 'templates',    label: 'Templates',             icon: FileText,       group: 'organization' },
  { id: 'folders',      label: 'Folders',               icon: FolderOpen,     group: 'organization' },
  { id: 'keywords',     label: 'Keywords & Labels',     icon: Tags,           group: 'organization' },
  { id: 'calendar',     label: 'Calendar',              icon: Calendar,       group: 'apps' },
  { id: 'contacts',     label: 'Contacts',              icon: BookUser,       group: 'apps' },
  { id: 'files',        label: 'Files',                 icon: HardDrive,      group: 'apps' },
  { id: 'sidebar_apps', label: 'Sidebar Apps',          icon: PanelLeftClose, group: 'apps' },
  { id: 'themes',       label: 'Themes',                icon: Palette,        group: 'system', experimental: true },
  { id: 'plugins',      label: 'Plugins',               icon: Puzzle,         group: 'system', experimental: true },
  { id: 'advanced',     label: 'Advanced',              icon: Wrench,         group: 'system' },
];

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
  const groupedTabs = groupTabs();

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
                return (
                  <Pressable
                    key={tab.id}
                    onPress={() => onTabSelect?.(tab.id)}
                    style={({ pressed }) => [styles.tabItem, pressed && styles.tabItemPressed]}
                  >
                    <View style={styles.tabItemLeft}>
                      <Icon size={16} color={colors.mutedForeground} />
                      <Text style={styles.tabItemLabel}>{tab.label}</Text>
                      {tab.experimental && (
                        <View style={styles.experimentalBadge}>
                          <Text style={styles.experimentalText}>Experimental</Text>
                        </View>
                      )}
                    </View>
                    <ChevronRight size={16} color={colors.mutedForeground} />
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
