import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, TextInput, Keyboard } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ArrowLeft, LogOut, Settings, ChevronRight, Search, X,
  Palette, User, Shield, UserPen, Palmtree, Calendar,
  Filter, FileText, FolderOpen, Tags, HardDrive,
  BookUser, KeyRound, PanelLeftClose, Bell, Puzzle, RefreshCw,
  LayoutGrid, BookOpen, PenLine, EyeOff, Languages, Info, Download,
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
import { DownloadsSettings } from '../components/settings/DownloadsSettings';
import { useLocaleStore } from '../stores/locale-store';
import { useAuthStore } from '../stores/auth-store';
import { useManagedAccountStore } from '../stores/managed-account-store';
import {
  sharedAccountSettingsTabs, useHasCalendar, useHasContacts, useHasFiles, useHasSieve, useHasVacation,
} from '../lib/capabilities';
import { supportsSideloadUpdates } from '../lib/platform-capabilities';
import { usePendingSettingsTab } from '../navigation/pending-settings-tab';
import { useBackWhileFocused } from '../lib/use-back-while-focused';
import {
  buildSettingsSearchIndex, normalizeSettingsQuery, subResultsForQuery, tabMatchesQuery,
  type SettingsTabId, type SubResult,
} from '../lib/settings-search';
import { SearchHighlightContext, type SearchHighlight } from '../components/settings/search-highlight';
import { BUILTIN_THEMES } from '../theme/builtin-themes';
import { getDictionary } from '../i18n';

type Tab = SettingsTabId;

type TabGroup = 'general' | 'appearance' | 'mail' | 'privacy' | 'apps' | 'advanced';

interface TabDef {
  id: Tab;
  label: string;
  icon: LucideIcon;
  group: TabGroup;
  experimental?: boolean;
  implemented: boolean;
  // Never listed (still reachable by deep link).
  hidden?: boolean;
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
  { id: 'downloads',       label: 'Downloads',          icon: Download,       group: 'mail',       implemented: true  },

  // Privacy & Security
  { id: 'security',        label: 'Security',           icon: Shield,         group: 'privacy',    implemented: true  },
  { id: 'encryption',      label: 'S/MIME Encryption',  icon: KeyRound,       group: 'privacy',    implemented: false },
  { id: 'content_senders', label: 'Content & Senders',  icon: EyeOff,         group: 'privacy',    implemented: true  },

  // Apps
  { id: 'calendar',        label: 'Calendar',           icon: Calendar,       group: 'apps',       implemented: true  },
  { id: 'contacts',        label: 'Contacts',           icon: BookUser,       group: 'apps',       implemented: true  },
  { id: 'files',           label: 'Files',              icon: HardDrive,      group: 'apps',       implemented: true  },
  { id: 'sidebar_apps',    label: 'Sidebar Apps',       icon: PanelLeftClose, group: 'apps',       implemented: true  },

  // Advanced
  { id: 'about_data',      label: 'About & Data',       icon: Info,           group: 'advanced',   implemented: true  },
  { id: 'themes',          label: 'Themes',             icon: Palette,        group: 'advanced',   implemented: true  },
  // Plugins run in the webmail only; the pane is an explainer reachable by
  // deep link, not from the list. Debug logging lives under About & Data.
  { id: 'plugins',         label: 'Plugins',            icon: Puzzle,         group: 'advanced',   experimental: true, implemented: true, hidden: true },
  { id: 'updates',         label: 'Updates',            icon: RefreshCw,      group: 'advanced',   implemented: true  },
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
  downloads: DownloadsSettings,
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

// Tabs whose feature does not exist on this platform never appear in the list.
// The "Updates" pane drives the sideload installer, which is Android-only - the
// current version and build are still shown under "About & Data".
const AVAILABLE_TABS: TabDef[] = TABS.filter(
  (t) => !t.hidden && (t.id !== 'updates' || supportsSideloadUpdates),
);

function groupTabs(only: ReadonlySet<Tab> | null) {
  return GROUP_ORDER.map(group => ({
    group,
    label: GROUP_LABELS[group],
    items: AVAILABLE_TABS.filter(t => t.group === group && (!only || only.has(t.id))),
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
  const [searchQuery, setSearchQuery] = useState('');
  // A tapped search result: its pane scrolls to the setting and flashes it.
  const [pendingHighlight, setPendingHighlight] = useState<{ tab: Tab; label: string } | null>(null);
  const paneScrollRef = React.useRef<ScrollView>(null);
  const paneContentRef = React.useRef<View>(null);
  // Subscribe to locale so labels re-render when the user picks a different language.
  const locale = useLocaleStore((s) => s.locale);
  const t = useLocaleStore((s) => s.t);
  const hasCalendar = useHasCalendar();
  const hasContacts = useHasContacts();
  const hasFiles = useHasFiles();
  const hasSieve = useHasSieve();
  const hasVacation = useHasVacation();

  // A shared/group account picked under "Shared with me" scopes Settings to
  // the panes that account can be managed in (webmail: scoped settings).
  const managedAccount = useManagedAccountStore((s) => s.managedAccount);
  const clearManagedAccount = useManagedAccountStore((s) => s.clear);
  const session = useAuthStore((s) => s.session);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const scopedTabs = React.useMemo<ReadonlySet<Tab> | null>(() => {
    void session; // dependency: capabilities come from the live session
    return managedAccount ? new Set<Tab>(sharedAccountSettingsTabs(managedAccount.id)) : null;
  }, [managedAccount, session]);
  // The scope belongs to one signed-in account and one visit to Settings.
  useEffect(() => { clearManagedAccount(); }, [activeAccountId, clearManagedAccount]);
  useEffect(() => () => clearManagedAccount(), [clearManagedAccount]);
  const leaveScope = React.useCallback(() => {
    clearManagedAccount();
    setSelectedTab('account');
  }, [clearManagedAccount]);

  const unavailableTabs = React.useMemo(() => {
    const set = new Set<Tab>();
    if (scopedTabs) return set; // only the shared account's supported panes are listed
    if (!hasCalendar) set.add('calendar');
    if (!hasContacts) set.add('contacts');
    if (!hasFiles) set.add('files');
    if (!hasSieve) set.add('filters');
    if (!hasVacation) set.add('vacation');
    return set;
  }, [scopedTabs, hasCalendar, hasContacts, hasFiles, hasSieve, hasVacation]);
  // A settings/<tab> deep link parks its target here; open it once. A tab the
  // managed shared account has no pane for returns to the user's own account.
  const pendingTab = usePendingSettingsTab((s) => s.tab);
  useEffect(() => {
    if (!pendingTab) return;
    const tab = usePendingSettingsTab.getState().consume();
    if (!tab || !TABS.some((t) => t.id === tab && t.implemented)) return;
    const scoped = useManagedAccountStore.getState().managedAccount;
    if (scoped && !(sharedAccountSettingsTabs(scoped.id) as string[]).includes(tab)) clearManagedAccount();
    setSelectedTab(tab as Tab);
  }, [pendingTab, clearManagedAccount]);
  const groupedTabs = React.useMemo(() => {
    void locale; // dependency: re-translate on locale change
    return groupTabs(scopedTabs).map((g) => ({
      ...g,
      label: t(`settings.tab_groups.${g.group}`, g.label),
      items: g.items.map((tab) => ({
        ...tab,
        label: t(`settings.tabs.${tab.id}`, tab.label),
      })),
    }));
  }, [locale, t, scopedTabs]);

  // Settings search (webmail: lib/settings-search). The index is built on the
  // first keystroke and again when the language changes.
  const query = normalizeSettingsQuery(searchQuery);
  const searching = query.length > 0;
  const searchIndex = React.useMemo(() => {
    if (!searching) return null;
    void locale; // dependency: re-translate on locale change
    return buildSettingsSearchIndex(getDictionary('en'), t, {
      themes: [
        {
          label: t('settings.themes.default_name', 'Bulwark'),
          description: t('settings.themes.default_description', 'The default light and dark palettes.'),
        },
        ...BUILTIN_THEMES.map((theme) => ({ label: theme.name, description: theme.description })),
      ],
    });
  }, [searching, locale, t]);
  const visibleGroups = searchIndex
    ? groupedTabs
        .map((g) => ({ ...g, items: g.items.filter((tab) => tabMatchesQuery(searchIndex, tab.id, tab.label, query)) }))
        .filter((g) => g.items.length > 0)
    : groupedTabs;

  const closePane = React.useCallback(() => {
    setSelectedTab(null);
    setPendingHighlight(null);
  }, []);

  // Settings is a tab and stays mounted behind the other tabs, so hardware
  // back is only claimed while it is the focused one.
  const handleBack = React.useCallback(() => {
    if (selectedTab) closePane();
    else if (searchQuery) setSearchQuery('');
    else leaveScope();
  }, [selectedTab, searchQuery, closePane, leaveScope]);
  useBackWhileFocused(!!selectedTab || !!searchQuery || !!managedAccount, handleBack);

  // The first row of the open pane whose label matches the tapped result
  // calls this once it is laid out.
  const revealHighlight = React.useCallback((view: View) => {
    const content = paneContentRef.current;
    if (content) {
      view.measureLayout(content, (_x, y) => {
        paneScrollRef.current?.scrollTo({ y: Math.max(0, y - spacing.lg), animated: true });
      }, () => undefined);
    }
    setPendingHighlight(null);
  }, []);
  const searchHighlight = React.useMemo<SearchHighlight | null>(
    () => (pendingHighlight && pendingHighlight.tab === selectedTab
      ? { label: pendingHighlight.label, reveal: revealHighlight }
      : null),
    [pendingHighlight, selectedTab, revealHighlight],
  );

  const scopeBanner = managedAccount ? (
    <Pressable
      onPress={leaveScope}
      accessibilityRole="button"
      style={({ pressed }) => [styles.scopeBanner, pressed && styles.scopeBannerPressed]}
    >
      <ArrowLeft size={16} color={c.mutedForeground} />
      <Text style={styles.scopeBack}>{t('settings.scoped.back', 'Back to my account')}</Text>
      <Text style={styles.scopeName} numberOfLines={1}>
        {t('settings.scoped.managing', 'Managing: {name}', { name: managedAccount.name })}
      </Text>
    </Pressable>
  ) : null;

  const handleTabPress = (tab: TabDef) => {
    if (!tab.implemented) return;
    if (unavailableTabs.has(tab.id)) return;
    Keyboard.dismiss();
    setSelectedTab(tab.id);
    setPendingHighlight(null);
    onTabSelect?.(tab.id);
  };

  const handleSubResultPress = (tab: TabDef, sub: SubResult) => {
    handleTabPress(tab);
    setPendingHighlight({ tab: tab.id, label: sub.label });
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
            onPress={closePane}
            accessibilityRole="button"
            accessibilityLabel={t('common.back', 'Back')}
            style={({ pressed }) => [styles.headerBackBtn, pressed && styles.headerBackBtnPressed]}
          >
            <ArrowLeft size={20} color={c.text} />
          </Pressable>
          <TabIcon size={20} color={c.mutedForeground} />
          <Text style={styles.headerTitle}>{tabLabel}</Text>
        </View>

        <ScrollView ref={paneScrollRef} style={styles.scrollArea} contentContainerStyle={styles.detailContent}>
          <View ref={paneContentRef}>
            <SearchHighlightContext.Provider value={searchHighlight}>
              {scopeBanner}
              {selectedTab === 'filters' ? (
                <FilterSettings
                  onOpenVacation={hasVacation ? () => setSelectedTab('vacation') : undefined}
                />
              ) : Component ? <Component /> : null}
            </SearchHighlightContext.Provider>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header - matches webmail mobile: h-14, border-b, back button + icon + title.
          Settings is a tab root, so the back button is only rendered when a
          parent passes onBack (it'd otherwise lead nowhere). */}
      <View style={styles.header}>
        {onBack ? (
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel={t('common.back', 'Back')}
            style={({ pressed }) => [styles.headerBackBtn, pressed && styles.headerBackBtnPressed]}
          >
            <ArrowLeft size={20} color={c.text} />
          </Pressable>
        ) : (
          <View style={styles.headerLeftSpacer} />
        )}
        <Settings size={20} color={c.mutedForeground} />
        <Text style={styles.headerTitle}>{t('settings.title', 'Settings')}</Text>
      </View>

      {/* Tab list - matches webmail mobile: flat grouped list, no cards */}
      <ScrollView
        style={styles.scrollArea}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {scopeBanner && <View style={styles.scopeBannerList}>{scopeBanner}</View>}
        <View style={styles.searchBar}>
          <Search size={16} color={c.mutedForeground} />
          <TextInput
            style={styles.searchInput}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder={t('settings.search_placeholder', 'Search settings')}
            placeholderTextColor={c.mutedForeground}
            accessibilityLabel={t('settings.search_placeholder', 'Search settings')}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
          />
          {searchQuery.length > 0 && (
            <Pressable
              onPress={() => setSearchQuery('')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('settings.search_clear', 'Clear search')}
            >
              <X size={16} color={c.mutedForeground} />
            </Pressable>
          )}
        </View>
        <View style={styles.tabList}>
          {visibleGroups.length === 0 && (
            <Text style={styles.searchEmpty}>{t('settings.search_no_results', 'No matching settings')}</Text>
          )}
          {visibleGroups.map((group, groupIndex) => (
            <View key={group.group}>
              {groupIndex > 0 && <View style={styles.groupDivider} />}

              <View style={styles.groupHeader}>
                <Text style={styles.groupLabel}>{group.label}</Text>
              </View>

              {group.items.map((tab) => {
                const Icon = tab.icon;
                const unavailable = unavailableTabs.has(tab.id);
                const disabled = !tab.implemented || unavailable;
                const badgeLabel = !tab.implemented
                  ? t('settings.badges.not_implemented', 'Not implemented')
                  : unavailable
                    ? t('settings.badges.unavailable', 'Unavailable')
                    : null;
                const row = (
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
                          <Text style={styles.experimentalText}>{t('settings.badges.experimental', 'Experimental')}</Text>
                        </View>
                      )}
                    </View>
                    {badgeLabel ? (
                      <View style={styles.notWorkingBadge}>
                        <Text style={styles.notWorkingText}>{badgeLabel}</Text>
                      </View>
                    ) : (
                      <ChevronRight size={16} color={c.mutedForeground} />
                    )}
                  </Pressable>
                );
                // The pane's matching settings, one tap from opening it there.
                const subs = searchIndex && !disabled ? subResultsForQuery(searchIndex, tab.id, query) : [];
                if (subs.length === 0) return row;
                return (
                  <View key={tab.id}>
                    {row}
                    {subs.map((sub) => (
                      <Pressable
                        key={sub.label}
                        onPress={() => handleSubResultPress(tab, sub)}
                        accessibilityRole="button"
                        style={({ pressed }) => [styles.subResult, pressed && styles.tabItemPressed]}
                      >
                        <Text style={styles.subResultText} numberOfLines={1}>{sub.label}</Text>
                      </Pressable>
                    ))}
                  </View>
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
    headerLeftSpacer: { width: spacing.sm },
    headerTitle: { ...typography.h3, color: c.text },

    scrollArea: { flex: 1 },
    scrollContent: { paddingBottom: 40 },
    detailContent: { padding: spacing.lg, paddingBottom: 40 },

    tabList: { paddingVertical: spacing.sm },

    // Search - matches webmail mobile: full-width input above the list,
    // matching settings as indented rows under their pane.
    searchBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginHorizontal: spacing.lg,
      marginTop: spacing.md,
      paddingHorizontal: spacing.md,
      height: componentSizes.inputHeight,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.background,
    },
    searchInput: { flex: 1, ...typography.body, color: c.text, paddingVertical: 0 },
    searchEmpty: {
      ...typography.body,
      color: c.mutedForeground,
      textAlign: 'center',
      paddingHorizontal: 20,
      paddingVertical: spacing.xxl,
    },
    subResult: { paddingLeft: 48, paddingRight: 20, paddingVertical: spacing.sm },
    subResultText: { ...typography.caption, color: c.mutedForeground },

    scopeBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginBottom: spacing.lg,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      backgroundColor: c.muted,
    },
    scopeBannerPressed: { opacity: 0.8 },
    scopeBannerList: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg },
    scopeBack: { ...typography.body, color: c.mutedForeground },
    scopeName: { ...typography.bodyMedium, color: c.text, flex: 1, textAlign: 'right' },

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
      backgroundColor: c.warningBg,
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
