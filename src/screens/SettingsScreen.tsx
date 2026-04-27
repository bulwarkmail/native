import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, BackHandler } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ArrowLeft, LogOut, Settings, ChevronRight,
  Palette, User, Shield, UserPen, Palmtree, Calendar,
  Filter, FileText, FolderOpen, Tags, HardDrive,
  BookUser, KeyRound, PanelLeftClose, Bell, Puzzle, RefreshCw,
  LayoutGrid, BookOpen, PenLine, EyeOff, Languages, Info, Bug,
  type LucideIcon,
} from 'lucide-react-native';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { ReadingSettings } from '../components/settings/ReadingSettings';
import { NotificationSettings } from '../components/settings/NotificationSettings';
import { AccountSettings } from '../components/settings/AccountSettings';
import { IdentitySettings } from '../components/settings/IdentitySettings';
import { VacationSettings } from '../components/settings/VacationSettings';
import { FolderSettings } from '../components/settings/FolderSettings';
import { AboutDataSettings } from '../components/settings/AboutDataSettings';
import { UpdatesSettings } from '../components/settings/UpdatesSettings';
import { AppearanceSettings } from '../components/settings/AppearanceSettings';
import { CalendarSettings } from '../components/settings/CalendarSettings';
import { ContactsSettings } from '../components/settings/ContactsSettings';
import { FilesSettings } from '../components/settings/FilesSettings';
import { FilterSettings } from '../components/settings/FilterSettings';
import { TemplateSettings } from '../components/settings/TemplateSettings';
import { KeywordSettings } from '../components/settings/KeywordSettings';
import { AccountSecuritySettings } from '../components/settings/AccountSecuritySettings';
import { SmimeSettings } from '../components/settings/SmimeSettings';
import { SidebarAppsSettings } from '../components/settings/SidebarAppsSettings';
import { ThemesSettings } from '../components/settings/ThemesSettings';
import { PluginsSettings } from '../components/settings/PluginsSettings';
import { ContentSendersSettings } from '../components/settings/ContentSendersSettings';
import { LanguageSettings } from '../components/settings/LanguageSettings';
import { ComposingSettings } from '../components/settings/ComposingSettings';
import { LayoutSettings } from '../components/settings/LayoutSettings';
import { useLocaleStore } from '../stores/locale-store';

type Tab =
  | 'account' | 'language' | 'notifications'
  | 'appearance' | 'layout'
  | 'reading' | 'composing' | 'identities' | 'vacation'
  | 'filters' | 'templates' | 'folders' | 'keywords'
  | 'security' | 'encryption' | 'content_senders'
  | 'calendar' | 'contacts' | 'files' | 'sidebar_apps'
  | 'about_data' | 'themes' | 'plugins' | 'updates' | 'debug';

type TabGroup = 'general' | 'appearance' | 'mail' | 'privacy' | 'apps' | 'advanced';

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
  appearance: 'Appearance',
  mail: 'Mail',
  privacy: 'Privacy & Security',
  apps: 'Apps',
  advanced: 'Advanced',
};

const GROUP_ORDER: TabGroup[] = ['general', 'appearance', 'mail', 'privacy', 'apps', 'advanced'];

const TABS: TabDef[] = [
  // General
  { id: 'account',         label: 'Account',            icon: User,           group: 'general',    implemented: true  },
  { id: 'language',        label: 'Language',           icon: Languages,      group: 'general',    implemented: true  },
  { id: 'notifications',   label: 'Notifications',      icon: Bell,           group: 'general',    implemented: true  },

  // Appearance
  { id: 'appearance',      label: 'Appearance',         icon: Palette,        group: 'appearance', implemented: true  },
  { id: 'layout',          label: 'Layout',             icon: LayoutGrid,     group: 'appearance', implemented: true  },

  // Mail
  { id: 'reading',         label: 'Reading',            icon: BookOpen,       group: 'mail',       implemented: true  },
  { id: 'composing',       label: 'Composing',          icon: PenLine,        group: 'mail',       implemented: true  },
  { id: 'identities',      label: 'Identities',         icon: UserPen,        group: 'mail',       implemented: true  },
  { id: 'vacation',        label: 'Vacation Responder', icon: Palmtree,       group: 'mail',       implemented: true  },
  { id: 'filters',         label: 'Filters & Rules',    icon: Filter,         group: 'mail',       implemented: true  },
  { id: 'templates',       label: 'Templates',          icon: FileText,       group: 'mail',       implemented: true  },
  { id: 'folders',         label: 'Folders',            icon: FolderOpen,     group: 'mail',       implemented: true  },
  { id: 'keywords',        label: 'Keywords & Labels',  icon: Tags,           group: 'mail',       implemented: true  },

  // Privacy & Security
  { id: 'security',        label: 'Security',           icon: Shield,         group: 'privacy',    implemented: true  },
  { id: 'encryption',      label: 'S/MIME Encryption',  icon: KeyRound,       group: 'privacy',    implemented: true  },
  { id: 'content_senders', label: 'Content & Senders',  icon: EyeOff,         group: 'privacy',    implemented: true  },

  // Apps
  { id: 'calendar',        label: 'Calendar',           icon: Calendar,       group: 'apps',       implemented: true  },
  { id: 'contacts',        label: 'Contacts',           icon: BookUser,       group: 'apps',       implemented: true  },
  { id: 'files',           label: 'Files',              icon: HardDrive,      group: 'apps',       implemented: true  },
  { id: 'sidebar_apps',    label: 'Sidebar Apps',       icon: PanelLeftClose, group: 'apps',       implemented: true  },

  // Advanced
  { id: 'about_data',      label: 'About & Data',       icon: Info,           group: 'advanced',   implemented: true  },
  { id: 'themes',          label: 'Themes',             icon: Palette,        group: 'advanced',   experimental: true, implemented: true  },
  { id: 'plugins',         label: 'Plugins',            icon: Puzzle,         group: 'advanced',   experimental: true, implemented: true  },
  { id: 'updates',         label: 'Updates',            icon: RefreshCw,      group: 'advanced',   implemented: true  },
  { id: 'debug',           label: 'Debug',              icon: Bug,            group: 'advanced',   implemented: false },
];

const TAB_COMPONENTS: Partial<Record<Tab, React.ComponentType<any>>> = {
  account: AccountSettings,
  language: LanguageSettings,
  notifications: NotificationSettings,
  appearance: AppearanceSettings,
  layout: LayoutSettings,
  reading: ReadingSettings,
  composing: ComposingSettings,
  identities: IdentitySettings,
  vacation: VacationSettings,
  filters: FilterSettings,
  templates: TemplateSettings,
  folders: FolderSettings,
  keywords: KeywordSettings,
  security: AccountSecuritySettings,
  encryption: SmimeSettings,
  content_senders: ContentSendersSettings,
  calendar: CalendarSettings,
  contacts: ContactsSettings,
  files: FilesSettings,
  sidebar_apps: SidebarAppsSettings,
  about_data: AboutDataSettings,
  themes: ThemesSettings,
  plugins: PluginsSettings,
  updates: UpdatesSettings,
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
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [selectedTab, setSelectedTab] = useState<Tab | null>(null);
  // Subscribe to locale so labels re-render when the user picks a different language.
  const locale = useLocaleStore((s) => s.locale);
  const t = useLocaleStore((s) => s.t);
  const groupedTabs = React.useMemo(() => {
    void locale; // dependency: re-translate on locale change
    return groupTabs().map((g) => ({
      ...g,
      label: t(`settings.tab_groups.${g.group}`, g.label),
      items: g.items.map((tab) => ({
        ...tab,
        label: t(`settings.tabs.${tab.id}`, tab.label),
      })),
    }));
  }, [locale, t]);

  useEffect(() => {
    if (!selectedTab) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setSelectedTab(null);
      return true;
    });
    return () => sub.remove();
  }, [selectedTab]);

  const handleTabPress = (tab: TabDef) => {
    if (!tab.implemented) return;
    setSelectedTab(tab.id);
    onTabSelect?.(tab.id);
  };

  if (selectedTab) {
    const tabDef = TABS.find((tab) => tab.id === selectedTab)!;
    const Component = TAB_COMPONENTS[selectedTab];
    const TabIcon = tabDef.icon;
    const tabLabel = t(`settings.tabs.${tabDef.id}`, tabDef.label);

    return (
      <SafeAreaView style={styles.container} edges={['top']}>
        <View style={styles.header}>
          <Pressable
            onPress={() => setSelectedTab(null)}
            style={({ pressed }) => [styles.headerBackBtn, pressed && styles.headerBackBtnPressed]}
          >
            <ArrowLeft size={20} color={c.text} />
          </Pressable>
          <TabIcon size={20} color={c.mutedForeground} />
          <Text style={styles.headerTitle}>{tabLabel}</Text>
        </View>

        <ScrollView style={styles.scrollArea} contentContainerStyle={styles.detailContent}>
          {Component ? <Component /> : null}
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header - matches webmail mobile: h-14, border-b, back button + icon + title */}
      <View style={styles.header}>
        <Pressable
          onPress={onBack}
          style={({ pressed }) => [styles.headerBackBtn, pressed && styles.headerBackBtnPressed]}
        >
          <ArrowLeft size={20} color={c.text} />
        </Pressable>
        <Settings size={20} color={c.mutedForeground} />
        <Text style={styles.headerTitle}>{t('settings.title', 'Settings')}</Text>
      </View>

      {/* Tab list - matches webmail mobile: flat grouped list, no cards */}
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
                      <Icon size={16} color={c.mutedForeground} />
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
                      <ChevronRight size={16} color={c.mutedForeground} />
                    )}
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>

        {/* Logout - matches webmail: border-t, destructive text, icon + label */}
        <View style={styles.logoutSection}>
          <Pressable
            onPress={onLogout}
            style={({ pressed }) => [styles.logoutBtn, pressed && styles.logoutBtnPressed]}
          >
            <LogOut size={16} color={c.error} />
            <Text style={styles.logoutText}>{t('sidebar.sign_out', 'Sign Out')}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      height: componentSizes.headerHeight,
      paddingHorizontal: spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      gap: spacing.sm,
    },
    headerBackBtn: {
      width: 40, height: 40,
      alignItems: 'center', justifyContent: 'center',
      borderRadius: radius.md,
    },
    headerBackBtnPressed: { backgroundColor: c.accent },
    headerTitle: { ...typography.h3, color: c.text },

    scrollArea: { flex: 1 },
    scrollContent: { paddingBottom: 40 },
    detailContent: { padding: spacing.lg, paddingBottom: 40 },

    tabList: { paddingVertical: spacing.sm },

    groupDivider: {
      height: 1, backgroundColor: c.border,
      marginHorizontal: 20, marginVertical: spacing.sm,
    },
    groupHeader: { paddingHorizontal: 20, paddingTop: spacing.md, paddingBottom: 6 },
    groupLabel: {
      fontSize: 11, fontWeight: '600',
      textTransform: 'uppercase', letterSpacing: 0.8,
      color: c.mutedForeground,
    },

    tabItem: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 20, paddingVertical: 14,
    },
    tabItemPressed: { backgroundColor: c.muted },
    tabItemLeft: {
      flexDirection: 'row', alignItems: 'center',
      gap: spacing.md, flex: 1,
    },
    tabItemLabel: { ...typography.body, color: c.text },

    experimentalBadge: {
      backgroundColor: 'rgba(202, 138, 4, 0.15)',
      borderRadius: radius.full,
      paddingHorizontal: 6, paddingVertical: 2,
    },
    experimentalText: { fontSize: 10, fontWeight: '500', color: c.warning },

    tabItemDisabled: { opacity: 0.55 },
    tabItemLabelDisabled: { color: c.mutedForeground },
    notWorkingBadge: {
      backgroundColor: c.muted,
      borderRadius: radius.full,
      paddingHorizontal: 8, paddingVertical: 2,
    },
    notWorkingText: { fontSize: 10, fontWeight: '500', color: c.mutedForeground },

    logoutSection: {
      borderTopWidth: 1, borderTopColor: c.border,
      paddingHorizontal: 20, paddingVertical: spacing.md,
    },
    logoutBtn: {
      flexDirection: 'row', alignItems: 'center', gap: spacing.md,
      paddingVertical: 10, paddingHorizontal: spacing.sm,
      borderRadius: radius.sm,
    },
    logoutBtnPressed: { backgroundColor: c.muted },
    logoutText: { ...typography.body, color: c.error },
  });
}
