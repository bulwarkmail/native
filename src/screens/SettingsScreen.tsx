import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable, TextInput, Keyboard } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLayout } from '../lib/use-layout';
import { confirmSignOut } from '../lib/sign-out-confirm';
import {
  Accessibility, ArrowLeft, LogOut, Search, X, ChevronRight,
  Palette, User, Shield, UserPen, Palmtree, Calendar,
  Filter, FileText, FolderOpen, Tags, HardDrive,
  BookUser, PanelLeftClose, Bell, RefreshCw,
  LayoutGrid, BookOpen, PenLine, EyeOff, Languages, Info, Download, KeyRound,
  Database, Bug, Scale, Users, RotateCcw,
  type AppIcon,
} from '../components/icons';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { ReadingSettings } from '../components/settings/ReadingSettings';
import { NotificationSettings } from '../components/settings/NotificationSettings';
import { AccountSettings } from '../components/settings/AccountSettings';
import { IdentitySettings } from '../components/settings/IdentitySettings';
import { VacationSettings } from '../components/settings/VacationSettings';
import { FolderSettings } from '../components/settings/FolderSettings';
import { StorageSettings } from '../components/settings/StorageSettings';
import { AboutSettings, APP_VERSION } from '../components/settings/AboutSettings';
import { TroubleshootingSettings } from '../components/settings/TroubleshootingSettings';
import { LicencesSettings } from '../components/settings/LicencesSettings';
import { PrivacySettings } from '../components/settings/PrivacySettings';
import { SettingsRow, SettingsGroupLabel } from '../components/settings/settings-section';
import Badge from '../components/Badge';
import SenderAvatar from '../components/SenderAvatar';
import { UpdatesSettings } from '../components/settings/UpdatesSettings';
import { AppearanceSettings } from '../components/settings/AppearanceSettings';
import { AccessibilitySettings } from '../components/settings/AccessibilitySettings';
import { CalendarSettings } from '../components/settings/CalendarSettings';
import { ContactsSettings } from '../components/settings/ContactsSettings';
import { FilesSettings } from '../components/settings/FilesSettings';
import { FilterSettings } from '../components/settings/FilterSettings';
import { TemplateSettings } from '../components/settings/TemplateSettings';
import { KeywordSettings } from '../components/settings/KeywordSettings';
import { AccountSecuritySettings } from '../components/settings/AccountSecuritySettings';
import { EncryptionSettings } from '../components/settings/EncryptionSettings';
import { SidebarAppsSettings } from '../components/settings/SidebarAppsSettings';
import { ThemesSettings } from '../components/settings/ThemesSettings';
import { ContentSendersSettings } from '../components/settings/ContentSendersSettings';
import { LanguageSettings } from '../components/settings/LanguageSettings';
import { ComposingSettings } from '../components/settings/ComposingSettings';
import { LayoutSettings } from '../components/settings/LayoutSettings';
import { DownloadsSettings } from '../components/settings/DownloadsSettings';
import { DelegateSettings } from '../components/settings/DelegateSettings';
import { RecoverDeletedSettings } from '../components/settings/RecoverDeletedSettings';
import { useDeletedItemsRecovery } from '../lib/recovery/use-deleted-items-recovery';
import { useDelegationAvailable } from '../lib/delegation/use-delegation-available';
import { useLocaleStore } from '../stores/locale-store';
import { useAuthStore } from '../stores/auth-store';
import { useManagedAccountStore } from '../stores/managed-account-store';
import { useAccountStore } from '../stores/account-store';
import { useSettingsStore } from '../stores/settings-store';
import { usePolicyStore } from '../stores/policy-store';
import { policyHiddenPages } from '../components/settings/policy-pages';
import { useUpdatesStore } from '../stores/updates-store';
import { SUPPORTED_LOCALES } from '../i18n';
import { settingsSummary, type SummaryState } from '../lib/settings-summary';
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
  icon: AppIcon;
  group: TabGroup;
  experimental?: boolean;
  implemented: boolean;
  // Never listed (still reachable by deep link).
  hidden?: boolean;
  /** A page opened from inside another one; back returns there. */
  parent?: Tab;
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
  { id: 'sharing',         label: 'Sharing',            icon: Users,          group: 'general',    implemented: true  },
  { id: 'language',        label: 'Language',           icon: Languages,      group: 'general',    implemented: true  },
  { id: 'notifications',   label: 'Notifications',      icon: Bell,           group: 'general',    implemented: true  },
  { id: 'accessibility',   label: 'Accessibility',      icon: Accessibility,  group: 'general',    implemented: true  },

  // Appearance
  { id: 'appearance',      label: 'Appearance',         icon: Palette,        group: 'appearance', implemented: true  },
  { id: 'layout',          label: 'Layout',             icon: LayoutGrid,     group: 'appearance', implemented: true  },

  // Mail
  { id: 'reading',         label: 'Reading',            icon: BookOpen,       group: 'mail',       implemented: true  },
  { id: 'composing',       label: 'Composing',          icon: PenLine,        group: 'mail',       implemented: true  },
  { id: 'identities',      label: 'Identities',         icon: UserPen,        group: 'mail',       implemented: true  },
  { id: 'vacation',        label: 'Vacation Responder', icon: Palmtree,       group: 'mail',       implemented: true  },
  { id: 'filters',         label: 'Filters & Rules',    icon: Filter,         group: 'mail',       implemented: true  },
  { id: 'recovery',        label: 'Recover deleted items', icon: RotateCcw,   group: 'mail',       implemented: true  },
  { id: 'templates',       label: 'Templates',          icon: FileText,       group: 'mail',       implemented: true  },
  { id: 'folders',         label: 'Folders',            icon: FolderOpen,     group: 'mail',       implemented: true  },
  { id: 'keywords',        label: 'Keywords & Labels',  icon: Tags,           group: 'mail',       implemented: true  },
  { id: 'downloads',       label: 'Downloads',          icon: Download,       group: 'mail',       implemented: true  },

  // Privacy & Security
  { id: 'security',        label: 'Security',           icon: Shield,         group: 'privacy',    implemented: true  },
  { id: 'content_senders', label: 'Content & Senders',  icon: EyeOff,         group: 'privacy',    implemented: true  },
  // PGP and S/MIME keys (#58); the webmail has them in its plugins' settings.
  { id: 'encryption',      label: 'Encryption',         icon: KeyRound,       group: 'privacy',    implemented: true  },

  // Apps
  { id: 'calendar',        label: 'Calendar',           icon: Calendar,       group: 'apps',       implemented: true  },
  { id: 'contacts',        label: 'Contacts',           icon: BookUser,       group: 'apps',       implemented: true  },
  { id: 'files',           label: 'Files',              icon: HardDrive,      group: 'apps',       implemented: true  },
  { id: 'sidebar_apps',    label: 'Sidebar Apps',       icon: PanelLeftClose, group: 'apps',       implemented: true  },

  // Advanced. Plugins come from the webmail, so the app has no page for them.
  { id: 'themes',          label: 'Themes',             icon: Palette,        group: 'advanced',   implemented: true  },
  { id: 'about_data',      label: 'Storage & backup',   icon: Database,       group: 'advanced',   implemented: true  },
  { id: 'updates',         label: 'Updates',            icon: RefreshCw,      group: 'advanced',   implemented: true  },
  { id: 'about',           label: 'About',              icon: Info,           group: 'advanced',   implemented: true  },
  { id: 'debug',           label: 'Troubleshooting',    icon: Bug,            group: 'advanced',   implemented: true, hidden: true, parent: 'about_data' },
  { id: 'licences',        label: 'Open-source licences', icon: Scale,        group: 'advanced',   implemented: true, hidden: true, parent: 'about' },
  { id: 'privacy',         label: 'Privacy',            icon: Shield,         group: 'advanced',   implemented: true, hidden: true, parent: 'about' },
];

// Labels of the pages that aren't in the webmail catalog under settings.tabs.
const TAB_LABEL_KEYS: Partial<Record<Tab, string>> = {
  about_data: 'settings.tabs.storage',
  about: 'settings.tabs.about',
  debug: 'settings.tabs.troubleshooting',
  licences: 'settings.about.licences',
  privacy: 'settings.about.privacy',
  sharing: 'delegates.tab',
  recovery: 'recover_deleted.tab',
  encryption: 'encryption.tab',
};
const tabLabelKey = (id: Tab) => TAB_LABEL_KEYS[id] ?? `settings.tabs.${id}`;

const TAB_COMPONENTS: Partial<Record<Tab, React.ComponentType<any>>> = {
  account: AccountSettings,
  language: LanguageSettings,
  notifications: NotificationSettings,
  accessibility: AccessibilitySettings,
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
  sharing: DelegateSettings,
  recovery: RecoverDeletedSettings,
  security: AccountSecuritySettings,
  content_senders: ContentSendersSettings,
  encryption: EncryptionSettings,
  calendar: CalendarSettings,
  contacts: ContactsSettings,
  files: FilesSettings,
  sidebar_apps: SidebarAppsSettings,
  themes: ThemesSettings,
  updates: UpdatesSettings,
  debug: TroubleshootingSettings,
  licences: LicencesSettings,
  privacy: PrivacySettings,
};

// Tabs whose feature does not exist on this platform never appear in the list.
// The "Updates" pane drives the sideload installer, which is Android-only - the
// current version and build are still shown under "About". Account opens
// from the card above the list.
const AVAILABLE_TABS: TabDef[] = TABS.filter(
  (t) => !t.hidden && t.id !== 'account' && (t.id !== 'updates' || supportsSideloadUpdates),
);

function groupTabs(only: ReadonlySet<Tab> | null, hidden: ReadonlySet<Tab>) {
  return GROUP_ORDER.map(group => ({
    group,
    label: GROUP_LABELS[group],
    items: AVAILABLE_TABS.filter(t => t.group === group && (!only || only.has(t.id)) && !hidden.has(t.id)),
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
  const { isSplit } = useLayout();
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
  // Webmail 1.19: Delegates and Recover deleted items are left out of the
  // list, not shown as "Not on this server", where the server lacks them.
  const recoveryAvailable = useDeletedItemsRecovery().available;
  const delegationAvailable = useDelegationAvailable();
  // Pages the organisation's policy takes away (feature gates, hidden pages).
  const policy = usePolicyStore((s) => s.effective);
  const hiddenTabs = React.useMemo(() => {
    const set = new Set<Tab>();
    if (!recoveryAvailable) set.add('recovery');
    if (!delegationAvailable) set.add('sharing');
    for (const page of policyHiddenPages(policy)) set.add(page as Tab);
    return set;
  }, [recoveryAvailable, delegationAvailable, policy]);

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
    return groupTabs(scopedTabs, hiddenTabs).map((g) => ({
      ...g,
      label: t(`settings.tab_groups.${g.group}`, g.label),
      items: g.items.map((tab) => ({
        ...tab,
        label: t(tabLabelKey(tab.id), tab.label),
      })),
    }));
  }, [locale, t, scopedTabs, hiddenTabs]);

  // The second line of each row: the pane's current value.
  const settings = useSettingsStore();
  const updateAvailable = useUpdatesStore((s) => s.hasUpdate());
  const updateSeverity = useUpdatesStore((s) => s.cachedLatest?.severity ?? 'normal');
  const updateChecked = useUpdatesStore((s) => s.lastCheckedAt > 0);
  const themeName = BUILTIN_THEMES.find((theme) => theme.id === settings.activeThemeId)?.name ?? null;
  const summaryState: SummaryState = {
    languageLabel: SUPPORTED_LOCALES.find((l) => l.code === locale)?.label ?? locale,
    timeFormat: settings.timeFormat,
    theme: settings.theme,
    themeName,
    emailNotificationsEnabled: settings.emailNotificationsEnabled,
    calendarNotificationsEnabled: settings.calendarNotificationsEnabled,
    calendarDefaultView: settings.calendarDefaultView,
    calendarFirstDayOfWeek: settings.calendarFirstDayOfWeek,
    offlineCacheEnabled: settings.offlineCacheEnabled,
    offlineCacheDays: settings.offlineCacheDays,
    offlineCacheMaxMB: settings.offlineCacheMaxMB,
    appVersion: APP_VERSION,
    update: updateAvailable
      ? (updateSeverity === 'normal' ? 'available' : 'security')
      : updateChecked ? 'current' : 'none',
  };

  // The signed-in account, shown as the card at the top of the list.
  const accounts = useAccountStore((s) => s.accounts);
  const authUsername = useAuthStore((s) => s.username);
  const authServerUrl = useAuthStore((s) => s.serverUrl);
  const account = accounts.find((a) => a.id === activeAccountId);
  const accountName = account?.displayName || authUsername || '';
  const accountEmail = account?.email || authUsername || '';
  const accountHost = hostOf(account?.serverUrl || authServerUrl || '');

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

  // A page whose feature went away (the license ran out, another account)
  // closes instead of staying open empty.
  useEffect(() => {
    if (selectedTab && hiddenTabs.has(selectedTab)) setSelectedTab(null);
  }, [selectedTab, hiddenTabs]);

  // Back from a page opened inside another one returns to that page.
  const closePane = React.useCallback(() => {
    setSelectedTab((tab) => TABS.find((def) => def.id === tab)?.parent ?? null);
    setPendingHighlight(null);
  }, []);
  const openPage = React.useCallback((tab: Tab) => {
    setSelectedTab(tab);
    setPendingHighlight(null);
  }, []);

  // Settings is a tab and stays mounted behind the other tabs, so hardware
  // back is only claimed while it is the focused one.
  const selectedParent = TABS.find((def) => def.id === selectedTab)?.parent;
  const handleBack = React.useCallback(() => {
    if (selectedTab && (!isSplit || selectedParent)) closePane();
    else if (searchQuery) setSearchQuery('');
    else leaveScope();
  }, [selectedTab, selectedParent, isSplit, searchQuery, closePane, leaveScope]);
  useBackWhileFocused((!!selectedTab && (!isSplit || !!selectedParent)) || !!searchQuery || !!managedAccount, handleBack);

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

  // On a wide window the section list and the open page sit side by side;
  // the first page is open from the start, so the right side is never empty.
  const firstTab: Tab | null = scopedTabs
    ? groupedTabs.flatMap((g) => g.items).find((tab) => tab.implemented && !unavailableTabs.has(tab.id))?.id ?? null
    : 'account';
  const shownTab = selectedTab ?? (isSplit ? firstTab : null);

  const renderPage = (selectedTab: Tab) => {
    const tabDef = TABS.find((tab) => tab.id === selectedTab)!;
    const Component = TAB_COMPONENTS[selectedTab];
    const tabLabel = t(tabLabelKey(tabDef.id), tabDef.label);

    return (
      <SafeAreaView style={styles.container} edges={isSplit ? ['top', 'right'] : ['top', 'left', 'right']}>
        <View style={[styles.header, (!isSplit || tabDef.parent) && styles.headerWithBack]}>
          {(!isSplit || tabDef.parent) && (
            <Pressable
              onPress={closePane}
              accessibilityRole="button"
              accessibilityLabel={t('common.back', 'Back')}
              style={({ pressed }) => [styles.headerBackBtn, pressed && styles.headerBackBtnPressed]}
            >
              <ArrowLeft size={22} color={c.text} />
            </Pressable>
          )}
          <Text style={styles.headerTitle} numberOfLines={1} accessibilityRole="header">{tabLabel}</Text>
        </View>

        {/* Keyed per page: React would otherwise reuse the list's ScrollView
            and open the page at the list's scroll offset. */}
        <ScrollView key={`page-${selectedTab}`} ref={paneScrollRef} style={styles.scrollArea} contentContainerStyle={styles.detailContent}>
          <View ref={paneContentRef}>
            <SearchHighlightContext.Provider value={searchHighlight}>
              {scopeBanner}
              {selectedTab === 'filters' ? (
                <FilterSettings
                  onOpenVacation={hasVacation ? () => setSelectedTab('vacation') : undefined}
                />
              ) : selectedTab === 'about' ? (
                <AboutSettings onOpen={openPage} />
              ) : selectedTab === 'about_data' ? (
                <StorageSettings onOpenTroubleshooting={() => openPage('debug')} />
              ) : Component ? <Component /> : null}
            </SearchHighlightContext.Provider>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  };

  // On a wide window the list marks the open page, or the page it was opened from.
  const listSelected = shownTab ? (TABS.find((def) => def.id === shownTab)?.parent ?? shownTab) : null;

  const list = (
    <SafeAreaView style={styles.container} edges={isSplit ? ['top', 'left'] : ['top', 'left', 'right']}>
      {/* Settings is a tab root, so the back button is only rendered when a
          parent passes onBack (it'd otherwise lead nowhere). */}
      <View style={[styles.header, onBack && styles.headerWithBack]}>
        {onBack && (
          <Pressable
            onPress={onBack}
            accessibilityRole="button"
            accessibilityLabel={t('common.back', 'Back')}
            style={({ pressed }) => [styles.headerBackBtn, pressed && styles.headerBackBtnPressed]}
          >
            <ArrowLeft size={22} color={c.text} />
          </Pressable>
        )}
        <Text style={styles.headerTitle} accessibilityRole="header">{t('settings.title', 'Settings')}</Text>
      </View>

      <ScrollView
        key="list"
        style={styles.scrollArea}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {scopeBanner && <View style={styles.scopeBannerList}>{scopeBanner}</View>}
        {!scopedTabs && (
          <Pressable
            onPress={() => handleTabPress(TABS.find((tab) => tab.id === 'account')!)}
            accessibilityRole="button"
            accessibilityLabel={[accountName, accountEmail, accountHost].filter(Boolean).join(', ')}
            accessibilityState={{ selected: isSplit && listSelected === 'account' }}
            style={({ pressed }) => [
              styles.accountCard,
              (pressed || (isSplit && listSelected === 'account')) && styles.accountCardActive,
            ]}
          >
            <SenderAvatar name={accountName} email={accountEmail} size={40} disableImages />
            <View style={styles.accountText}>
              <Text style={styles.accountName} numberOfLines={1}>{accountName}</Text>
              <Text style={styles.accountMeta} numberOfLines={1}>
                {[accountEmail !== accountName ? accountEmail : null, accountHost].filter(Boolean).join(' · ')}
              </Text>
            </View>
            <ChevronRight size={16} color={c.mutedForeground} />
          </Pressable>
        )}
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
              hitSlop={12}
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
          {visibleGroups.map((group) => (
            <View key={group.group}>
              <SettingsGroupLabel>{group.label}</SettingsGroupLabel>
              {group.items.map((tab) => {
                const unavailable = unavailableTabs.has(tab.id);
                const disabled = !tab.implemented || unavailable;
                const badge = unavailable
                  ? <Badge>{t('settings.badges.not_on_server', 'Not on this server')}</Badge>
                  : tab.experimental
                    ? <Badge>{t('settings.badges.experimental', 'Experimental')}</Badge>
                    : null;
                const row = (
                  <SettingsRow
                    key={tab.id}
                    icon={tab.icon}
                    title={tab.label}
                    value={disabled ? null : settingsSummary(tab.id, summaryState, t)}
                    onPress={() => handleTabPress(tab)}
                    disabled={disabled}
                    selected={isSplit && tab.id === listSelected}
                    badge={badge}
                  />
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
                        style={({ pressed }) => [styles.subResult, pressed && styles.subResultPressed]}
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

        <View style={styles.logoutSection}>
          <Pressable
            onPress={() => { if (onLogout) confirmSignOut(t, {}, onLogout); }}
            accessibilityRole="button"
            style={({ pressed }) => [styles.logoutBtn, pressed && styles.logoutBtnPressed]}
          >
            <LogOut size={20} color={c.error} />
            <Text style={styles.logoutText}>{t('sidebar.sign_out', 'Sign Out')}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );

  if (!isSplit) return shownTab ? renderPage(shownTab) : list;
  return (
    <View style={styles.splitRow}>
      <View style={[styles.splitList, { width: SETTINGS_LIST_WIDTH }]}>{list}</View>
      <View style={styles.splitPage}>{shownTab ? renderPage(shownTab) : null}</View>
    </View>
  );
}

/** The section list beside an open page on a wide window. */
const SETTINGS_LIST_WIDTH = 320;

function hostOf(url: string): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    splitRow: { flex: 1, flexDirection: 'row', backgroundColor: c.background },
    splitList: { borderRightWidth: 1, borderRightColor: c.border },
    splitPage: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      height: componentSizes.headerHeight,
      paddingHorizontal: spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      gap: spacing.xs,
    },
    headerWithBack: { paddingHorizontal: spacing.xs },
    headerBackBtn: {
      width: 48, height: 48,
      alignItems: 'center', justifyContent: 'center',
      borderRadius: radius.md,
    },
    headerBackBtnPressed: { backgroundColor: c.muted },
    headerTitle: { fontSize: 18, fontWeight: '600', lineHeight: 24, color: c.text, flexShrink: 1 },

    scrollArea: { flex: 1 },
    scrollContent: { paddingTop: spacing.md, paddingBottom: 40 },
    // A page keeps form width on a wide pane: labels and their controls
    // 700 dp apart are hard to read across.
    detailContent: { padding: spacing.lg, paddingBottom: 40, width: '100%', maxWidth: 720, alignSelf: 'center' },

    accountCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      marginHorizontal: spacing.lg,
      marginBottom: spacing.md,
      padding: spacing.md,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      backgroundColor: c.card,
    },
    accountCardActive: { backgroundColor: c.muted },
    accountText: { flex: 1, minWidth: 0, gap: 2 },
    accountName: { fontSize: 15, fontWeight: '500', lineHeight: 20, color: c.text },
    accountMeta: { fontSize: 13, lineHeight: 18, color: c.mutedForeground },

    tabList: { paddingBottom: spacing.sm },

    // Search - matches webmail mobile: full-width input above the list,
    // matching settings as indented rows under their pane.
    searchBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginHorizontal: spacing.lg,
      marginBottom: spacing.xs,
      paddingHorizontal: spacing.md,
      minHeight: componentSizes.inputHeight,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
    },
    searchInput: { flex: 1, ...typography.body, color: c.text, paddingVertical: 0 },
    searchEmpty: {
      ...typography.body,
      color: c.mutedForeground,
      textAlign: 'center',
      paddingHorizontal: 20,
      paddingVertical: spacing.xxl,
    },
    subResult: { minHeight: 40, justifyContent: 'center', paddingLeft: 50, paddingRight: spacing.lg },
    subResultPressed: { backgroundColor: c.surfaceHover },
    subResultText: { fontSize: 13, color: c.mutedForeground },

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
    scopeBannerList: { paddingHorizontal: spacing.lg },
    scopeBack: { ...typography.body, color: c.mutedForeground },
    scopeName: { ...typography.bodyMedium, color: c.text, flex: 1, textAlign: 'right' },

    logoutSection: {
      marginHorizontal: spacing.lg,
      marginTop: spacing.md,
      paddingTop: spacing.xs,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    logoutBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 14,
      minHeight: 48,
      borderRadius: radius.sm,
    },
    logoutBtnPressed: { backgroundColor: c.surfaceHover },
    logoutText: { fontSize: 15, lineHeight: 20, color: c.error },
  });
}
