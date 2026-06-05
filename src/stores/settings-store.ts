import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Identity } from '../api/types';
import { getIdentities as fetchIdentities } from '../api/identity';

export type ExternalContentPolicy = 'allow' | 'block' | 'ask';
export type ThemeMode = 'light' | 'dark' | 'system';
export type FontSize = 'small' | 'medium' | 'large';
export type Density = 'extra-compact' | 'compact' | 'regular' | 'comfortable';
export type DeleteAction = 'trash' | 'trash-and-read' | 'permanent';
export type MailLayout = 'split' | 'focus';
export type MailAttachmentAction = 'preview' | 'download';
export type AttachmentPosition = 'beside-sender' | 'below-header';
export type SwipeAction =
  | 'none'
  | 'archive'
  | 'delete'
  | 'spam'
  | 'read'
  | 'star'
  | 'pin'
  | 'move';
export type SwipeMode = 'instant' | 'reveal';
// Actions that can be placed in the email reader's bottom quick-action bar.
// The first three are the reply family (the default bar); any reply-family
// action the user removes from the bar is relocated to the top toolbar so it
// stays reachable.
export type QuickAction =
  | 'reply'
  | 'replyAll'
  | 'forward'
  | 'delete'
  | 'archive'
  | 'markUnread'
  | 'star'
  | 'move'
  | 'spam'
  | 'tag';

export const REPLY_QUICK_ACTIONS: QuickAction[] = ['reply', 'replyAll', 'forward'];

export const ALL_QUICK_ACTIONS: QuickAction[] = [
  'reply',
  'replyAll',
  'forward',
  'delete',
  'archive',
  'markUnread',
  'star',
  'move',
  'spam',
  'tag',
];

// The reader bottom bar always shows exactly three quick actions (between the
// prev/next nav buttons). Coerce any persisted value into three unique, valid
// ids, backfilling from the reply-family default when entries are missing.
export function normalizeBottomQuickActions(value: unknown): QuickAction[] {
  const out: QuickAction[] = [];
  if (Array.isArray(value)) {
    for (const a of value) {
      if (ALL_QUICK_ACTIONS.includes(a as QuickAction) && !out.includes(a as QuickAction)) {
        out.push(a as QuickAction);
      }
    }
  }
  for (const d of REPLY_QUICK_ACTIONS) {
    if (out.length >= 3) break;
    if (!out.includes(d)) out.push(d);
  }
  return out.slice(0, 3);
}
export type ArchiveMode = 'single' | 'year' | 'month';
export type CalendarView = 'month' | 'week' | 'day' | 'agenda';
export type FirstDayOfWeek = 0 | 1;
export type TimeFormat = '12h' | '24h';
// Email-list date rendering style. Mirrors the webmail `dateFormat` setting:
//   smart    — locale-aware, age-bucketed (today→time, this week→weekday+time, older→date)
//   relative — "1h ago", "2d ago"
//   full     — always the full locale date + time
export type DateFormat = 'smart' | 'relative' | 'full';
export type CalendarHoverPreview = 'instant' | 'delay-500ms' | 'delay-1s' | 'delay-2s' | 'off';
export type FilesFolderLayout = 'inline' | 'sidebar';
export type FilesViewMode = 'list' | 'grid';
export type FilesSortKey = 'name' | 'size' | 'modified';
export type FilesSortDir = 'asc' | 'desc';
export type NotificationSound = 'default' | 'chime' | 'ping' | 'pop' | 'none';
// Filename transform for downloads/exports (mirrors webmail SpaceReplacement).
export type SpaceReplacement = 'keep' | 'underscore' | 'dash';

const STORAGE_KEY = 'webmail:settings:v1';

export interface SidebarApp {
  id: string;
  name: string;
  url: string;
  icon: string;
  openMode: 'tab' | 'inline';
  showOnMobile: boolean;
}

interface PersistedSettings {
  // Privacy & content
  externalContentPolicy: ExternalContentPolicy;
  trustedSenders: string[];
  trustedSendersAddressBook: boolean;
  senderFavicons: boolean;
  hideInlineImageAttachments: boolean;

  // Language, region & time
  dateFormat: DateFormat;
  timeFormat: TimeFormat;

  // Unified inbox: also pull in group/shared inboxes reachable through each
  // logged-in account (parity with the webmail `includeGroupInUnified` setting).
  includeGroupInUnified: boolean;

  // Contacts
  groupContactsByLetter: boolean;

  // Appearance
  theme: ThemeMode;
  fontSize: FontSize;
  density: Density;
  showToolbarLabels: boolean;
  animationsEnabled: boolean;
  emailAlwaysLightMode: boolean;
  activeThemeId: string | null;

  // Composing
  autoSelectReplyIdentity: boolean;
  attachmentReminderEnabled: boolean;
  attachmentReminderKeywords: string[];
  plainTextMode: boolean;
  // Undo-send window: every send is deferred by this many seconds (via the
  // server's FUTURERELEASE support) so it can be cancelled. 0 = send instantly.
  sendDelaySeconds: number;

  // Reading
  markAsReadDelay: number;
  deleteAction: DeleteAction;
  permanentlyDeleteJunk: boolean;
  showPreview: boolean;
  mailLayout: MailLayout;
  emailsPerPage: number;
  disableThreading: boolean;
  mailAttachmentAction: MailAttachmentAction;
  attachmentPosition: AttachmentPosition;

  // Layout / list interactions
  swipeLeftAction: SwipeAction;
  swipeRightAction: SwipeAction;
  swipeMode: SwipeMode;

  // Email reader's bottom quick-action bar (3 slots). Defaults to the reply
  // family; reply-family actions removed from here move to the top toolbar.
  bottomQuickActions: QuickAction[];

  // Archive
  archiveMode: ArchiveMode;

  // Calendar
  calendarDefaultView: CalendarView;
  calendarFirstDayOfWeek: FirstDayOfWeek;
  calendarTimeFormat: TimeFormat;
  calendarShowTimeInMonth: boolean;
  calendarShowWeekNumbers: boolean;
  calendarHoverPreview: CalendarHoverPreview;
  showBirthdayCalendar: boolean;
  enableCalendarTasks: boolean;
  showTasksOnCalendar: boolean;

  // Files
  filesFolderLayout: FilesFolderLayout;
  filesDefaultViewMode: FilesViewMode;
  filesDefaultSortKey: FilesSortKey;
  filesDefaultSortDir: FilesSortDir;
  filesShowIcons: boolean;
  filesColoredIcons: boolean;
  filesShowThumbnails: boolean;
  filesShowHiddenFiles: boolean;

  // Notifications
  notificationSoundChoice: NotificationSound;
  emailNotificationsEnabled: boolean;
  emailNotificationSound: boolean;
  calendarNotificationsEnabled: boolean;
  calendarNotificationSound: boolean;
  calendarInvitationParsingEnabled: boolean;

  // Sidebar apps
  sidebarApps: SidebarApp[];
  keepAppsLoaded: boolean;

  // S/MIME defaults (key/cert lists are server-managed; only UI-level prefs persist)
  smimeDefaultEncrypt: boolean;
  smimeRememberUnlocked: boolean;
  smimeAutoImport: boolean;

  // Filters UI state
  filtersExpandedView: boolean;

  // Plugins (UI-level enable map)
  pluginEnabled: Record<string, boolean>;

  // Downloads / export filenames: templates and a filename transform applied
  // when exporting a message as .eml or saving an attachment.
  emailExportTemplate: string;
  attachmentExportTemplate: string;
  exportSpaceReplacement: SpaceReplacement;
  exportLowercase: boolean;
  exportStripDiacritics: boolean;

  // Offline mail cache: download recent message bodies in the background so
  // they can be opened without network. Days windows the lookback. Attachment
  // caching is intentionally not implemented yet — bodies-only is much
  // smaller and covers the "open recent mail offline" UX on its own.
  offlineCacheEnabled: boolean;
  offlineCacheDays: number;
  // Hard cap on the on-disk body cache, in megabytes. When a sync pushes the
  // cache past this, the oldest messages are evicted to fit.
  offlineCacheMaxMB: number;
}

const DEFAULT_PERSISTED: PersistedSettings = {
  dateFormat: 'smart',
  timeFormat: '24h',
  includeGroupInUnified: false,

  externalContentPolicy: 'ask',
  trustedSenders: [],
  trustedSendersAddressBook: false,
  senderFavicons: true,
  hideInlineImageAttachments: true,

  groupContactsByLetter: true,

  theme: 'system',
  fontSize: 'medium',
  density: 'regular',
  showToolbarLabels: true,
  animationsEnabled: true,
  emailAlwaysLightMode: false,
  activeThemeId: null,

  autoSelectReplyIdentity: true,
  attachmentReminderEnabled: true,
  attachmentReminderKeywords: ['attached', 'attachment', 'attaching', 'enclosed'],
  plainTextMode: false,
  sendDelaySeconds: 0,

  markAsReadDelay: 0,
  deleteAction: 'trash',
  permanentlyDeleteJunk: false,
  showPreview: true,
  mailLayout: 'split',
  emailsPerPage: 25,
  disableThreading: false,
  mailAttachmentAction: 'preview',
  attachmentPosition: 'beside-sender',

  swipeLeftAction: 'archive',
  swipeRightAction: 'read',
  swipeMode: 'instant',

  bottomQuickActions: ['reply', 'replyAll', 'forward'],

  archiveMode: 'single',

  calendarDefaultView: 'month',
  calendarFirstDayOfWeek: 1,
  calendarTimeFormat: '24h',
  calendarShowTimeInMonth: true,
  calendarShowWeekNumbers: false,
  calendarHoverPreview: 'delay-500ms',
  showBirthdayCalendar: true,
  enableCalendarTasks: false,
  showTasksOnCalendar: true,

  filesFolderLayout: 'inline',
  filesDefaultViewMode: 'list',
  filesDefaultSortKey: 'name',
  filesDefaultSortDir: 'asc',
  filesShowIcons: true,
  filesColoredIcons: true,
  filesShowThumbnails: true,
  filesShowHiddenFiles: false,

  notificationSoundChoice: 'default',
  emailNotificationsEnabled: true,
  emailNotificationSound: true,
  calendarNotificationsEnabled: true,
  calendarNotificationSound: true,
  calendarInvitationParsingEnabled: true,

  sidebarApps: [],
  keepAppsLoaded: false,

  smimeDefaultEncrypt: false,
  smimeRememberUnlocked: false,
  smimeAutoImport: true,

  filtersExpandedView: false,

  pluginEnabled: {},

  emailExportTemplate: '{date} ({from}-{to}) {subject}',
  attachmentExportTemplate: '{filename}',
  exportSpaceReplacement: 'keep',
  exportLowercase: false,
  exportStripDiacritics: false,

  offlineCacheEnabled: false,
  offlineCacheDays: 7,
  offlineCacheMaxMB: 50,
};

export interface SettingsState extends PersistedSettings {
  identities: Identity[];
  loading: boolean;
  error: string | null;
  hydrated: boolean;

  fetchIdentities: () => Promise<void>;
  hydrate: () => Promise<void>;

  // Generic setter — preferred for new code.
  updateSetting: <K extends keyof PersistedSettings>(
    key: K,
    value: PersistedSettings[K],
  ) => void;

  // Legacy named setters — preserved so existing call sites keep working.
  setExternalContentPolicy: (policy: ExternalContentPolicy) => void;
  setSenderFavicons: (enabled: boolean) => void;
  setGroupContactsByLetter: (enabled: boolean) => void;
  setTheme: (theme: ThemeMode) => void;
  setFontSize: (size: FontSize) => void;
  setDensity: (density: Density) => void;
  setShowToolbarLabels: (enabled: boolean) => void;
  setAnimationsEnabled: (enabled: boolean) => void;
  setEmailAlwaysLightMode: (enabled: boolean) => void;
  setAutoSelectReplyIdentity: (enabled: boolean) => void;
  setAttachmentReminderEnabled: (enabled: boolean) => void;
  setAttachmentReminderKeywords: (keywords: string[]) => void;
  setSwipeLeftAction: (action: SwipeAction) => void;
  setSwipeRightAction: (action: SwipeAction) => void;
  setSwipeMode: (mode: SwipeMode) => void;
  setArchiveMode: (mode: ArchiveMode) => void;

  // Trusted senders
  addTrustedSender: (email: string) => void;
  removeTrustedSender: (email: string) => void;
  isSenderTrusted: (email: string) => boolean;

  // Sidebar apps
  addSidebarApp: (app: Omit<SidebarApp, 'id'>) => void;
  updateSidebarApp: (id: string, updates: Partial<Omit<SidebarApp, 'id'>>) => void;
  removeSidebarApp: (id: string) => void;
  reorderSidebarApps: (apps: SidebarApp[]) => void;

  // Plugins
  setPluginEnabled: (id: string, enabled: boolean) => void;

  reset: () => void;
}

const PERSIST_KEYS: (keyof PersistedSettings)[] = Object.keys(
  DEFAULT_PERSISTED,
) as (keyof PersistedSettings)[];

function snapshot(state: SettingsState): PersistedSettings {
  const out: Record<string, unknown> = {};
  for (const k of PERSIST_KEYS) {
    out[k] = state[k];
  }
  return out as unknown as PersistedSettings;
}

function persist(state: PersistedSettings): void {
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch((err) => {
    console.warn('[settings-store] persist failed', err);
  });
}

function mergeWithDefaults(parsed: Partial<PersistedSettings>): PersistedSettings {
  const out: Record<string, unknown> = { ...DEFAULT_PERSISTED };
  for (const k of PERSIST_KEYS) {
    const v = parsed[k];
    if (v === undefined || v === null) continue;
    const def = DEFAULT_PERSISTED[k];
    // Type-tolerant merge: only adopt when the basic shape matches the default.
    if (Array.isArray(def)) {
      if (Array.isArray(v)) out[k] = v;
    } else if (typeof def === 'object') {
      if (typeof v === 'object' && !Array.isArray(v)) out[k] = v;
    } else if (typeof def === typeof v) {
      out[k] = v;
    }
  }
  return out as unknown as PersistedSettings;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULT_PERSISTED,
  identities: [],
  loading: false,
  error: null,
  hydrated: false,

  fetchIdentities: async () => {
    set({ loading: true, error: null });
    try {
      const identities = await fetchIdentities();
      set({ identities, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load identities' });
    }
  },

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PersistedSettings>;
        set({ ...mergeWithDefaults(parsed), hydrated: true });
        return;
      }
    } catch (err) {
      console.warn('[settings-store] hydrate failed', err);
    }
    set({ hydrated: true });
  },

  updateSetting: (key, value) => {
    set({ [key]: value } as Partial<SettingsState>);
    persist(snapshot(get()));
  },

  setExternalContentPolicy: (policy) => { set({ externalContentPolicy: policy }); persist(snapshot(get())); },
  setSenderFavicons: (enabled) => { set({ senderFavicons: enabled }); persist(snapshot(get())); },
  setGroupContactsByLetter: (enabled) => { set({ groupContactsByLetter: enabled }); persist(snapshot(get())); },
  setTheme: (theme) => { set({ theme }); persist(snapshot(get())); },
  setFontSize: (fontSize) => { set({ fontSize }); persist(snapshot(get())); },
  setDensity: (density) => { set({ density }); persist(snapshot(get())); },
  setShowToolbarLabels: (enabled) => { set({ showToolbarLabels: enabled }); persist(snapshot(get())); },
  setAnimationsEnabled: (enabled) => { set({ animationsEnabled: enabled }); persist(snapshot(get())); },
  setEmailAlwaysLightMode: (enabled) => { set({ emailAlwaysLightMode: enabled }); persist(snapshot(get())); },
  setAutoSelectReplyIdentity: (enabled) => { set({ autoSelectReplyIdentity: enabled }); persist(snapshot(get())); },
  setAttachmentReminderEnabled: (enabled) => { set({ attachmentReminderEnabled: enabled }); persist(snapshot(get())); },
  setAttachmentReminderKeywords: (keywords) => { set({ attachmentReminderKeywords: keywords }); persist(snapshot(get())); },
  setSwipeLeftAction: (action) => { set({ swipeLeftAction: action }); persist(snapshot(get())); },
  setSwipeRightAction: (action) => { set({ swipeRightAction: action }); persist(snapshot(get())); },
  setSwipeMode: (mode) => { set({ swipeMode: mode }); persist(snapshot(get())); },
  setArchiveMode: (mode) => { set({ archiveMode: mode }); persist(snapshot(get())); },

  addTrustedSender: (email) => {
    const normalized = email.toLowerCase().trim();
    if (!normalized) return;
    const current = get().trustedSenders;
    if (current.includes(normalized)) return;
    set({ trustedSenders: [...current, normalized] });
    persist(snapshot(get()));
  },

  removeTrustedSender: (email) => {
    const normalized = email.toLowerCase().trim();
    set({ trustedSenders: get().trustedSenders.filter((e) => e !== normalized) });
    persist(snapshot(get()));
  },

  isSenderTrusted: (email) => {
    const normalized = email.toLowerCase().trim();
    return get().trustedSenders.includes(normalized);
  },

  addSidebarApp: (app) => {
    const id = `app-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    set({ sidebarApps: [...get().sidebarApps, { ...app, id }] });
    persist(snapshot(get()));
  },

  updateSidebarApp: (id, updates) => {
    set({
      sidebarApps: get().sidebarApps.map((a) => (a.id === id ? { ...a, ...updates } : a)),
    });
    persist(snapshot(get()));
  },

  removeSidebarApp: (id) => {
    set({ sidebarApps: get().sidebarApps.filter((a) => a.id !== id) });
    persist(snapshot(get()));
  },

  reorderSidebarApps: (apps) => {
    set({ sidebarApps: apps });
    persist(snapshot(get()));
  },

  setPluginEnabled: (id, enabled) => {
    set({ pluginEnabled: { ...get().pluginEnabled, [id]: enabled } });
    persist(snapshot(get()));
  },

  reset: () => set({
    identities: [],
    loading: false,
    error: null,
  }),
}));
