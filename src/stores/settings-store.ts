import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Identity } from '../api/types';
import { getIdentities as fetchIdentities } from '../api/identity';
import type { SortLevel, MessageListOrderScope } from '../lib/message-list-order';

export type ExternalContentPolicy = 'allow' | 'block' | 'ask';
export type ThemeMode = 'light' | 'dark' | 'system';
export type FontSize = 'small' | 'medium' | 'large';
export type Density = 'extra-compact' | 'compact' | 'regular' | 'comfortable';
export type DeleteAction = 'trash' | 'trash-and-read' | 'permanent';
export type MailAttachmentAction = 'preview' | 'download';
export type AttachmentPosition = 'beside-sender' | 'below-header';
export type PlainTextFont = 'sans' | 'mono';
export type MessageSpacing = 'auto' | 'always' | 'edge';
export type ReadReceiptResponse = 'ask' | 'always' | 'never';
export type PostExportAction = 'keep' | 'archive' | 'trash';
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
export type SignaturePosition = 'above_quote' | 'below_quote';
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
// 0 = Sunday, 1 = Monday, 6 = Saturday (same values as the webmail).
export type FirstDayOfWeek = 0 | 1 | 6;
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
// Filename transform for downloads/exports (mirrors webmail SpaceReplacement).
export type SpaceReplacement = 'keep' | 'underscore' | 'dash';

// Debug log categories (mirrors the webmail's DebugCategory). Used by lib/debug.ts.
export type DebugCategory =
  | 'jmap'
  | 'calendar'
  | 'tasks'
  | 'auth'
  | 'filters'
  | 'email'
  | 'push'
  | 'contacts';

export const ALL_DEBUG_CATEGORIES: DebugCategory[] = [
  'jmap', 'calendar', 'tasks', 'auth', 'filters', 'email', 'push', 'contacts',
];

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
  // null = not decided yet and treated as off; only the user's toggle in
  // Content & Senders turns it on, false = user opted out.
  trustedSendersAddressBook: boolean | null;
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
  // Sort (and group) the contact list by surname instead of given name so
  // family members sit together (#963).
  sortContactsByLastName: boolean;

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
  // Signature placement in replies/forwards and the RFC 3676 "-- " separator.
  signaturePosition: SignaturePosition;
  signatureSeparatorEnabled: boolean;
  // Pre-check "request read receipt" in the composer.
  requestReadReceiptDefault: boolean;
  // Confirm before sending a message without a subject (#684).
  emptySubjectWarningEnabled: boolean;
  // Draft autosave debounce, milliseconds.
  autoSaveDraftInterval: number;
  // Character separating user from tag (e.g. "user+tag@"), RFC 5233.
  subAddressDelimiter: string;
  // Default sender identity per JMAP account id (#507).
  preferredIdentityIds: Record<string, string>;

  // Reading
  markAsReadDelay: number;
  deleteAction: DeleteAction;
  permanentlyDeleteJunk: boolean;
  showPreview: boolean;
  emailsPerPage: number;
  // Mail list sort order: oldest-first when true. Applies to every mailbox
  // (the JMAP Email/query sorts by receivedAt).
  mailSortAscending: boolean;
  disableThreading: boolean;
  // Configurable list order (#718): presets / up to 3 levels mapped onto the
  // JMAP sort, applied to the Inbox only or to every folder. Same shape as
  // the webmail so a settings blob round-trips.
  messageListOrder: SortLevel[];
  messageListOrderScope: MessageListOrderScope;
  // Load sender favicons inside Junk (off by default, webmail 1.5.1).
  showAvatarsInJunk: boolean;
  // Show the "/ total" part of the folder counts in the drawer (#498).
  showFolderTotalCount: boolean;
  // Unified views span every logged-in account instead of just the active
  // one (own + its shared/group folders). Off by default like the webmail.
  unifiedCrossAccount: boolean;
  mailAttachmentAction: MailAttachmentAction;
  attachmentPosition: AttachmentPosition;
  // Reader body: font for text/plain bodies (#830), gutter around the body,
  // how to answer read-receipt requests (RFC 8098) and what to do with a
  // message after it was exported as .eml.
  plainTextFont: PlainTextFont;
  messageSpacing: MessageSpacing;
  readReceiptResponse: ReadReceiptResponse;
  postExportAction: PostExportAction;

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
  // IANA zone the calendar works in, or 'auto' to follow the device (#755).
  // Same key semantics as the webmail's `timeZone` setting.
  calendarTimeZone: string;
  showBirthdayCalendar: boolean;
  enableCalendarTasks: boolean;
  showTasksOnCalendar: boolean;
  // Per-viewer color overrides for shared calendars, keyed by
  // sharedCalendarColorKey(). Lets the user recolor calendars shared with
  // them without changing the owner's color (parity with webmail #345).
  sharedCalendarColors: Record<string, string>;

  // Files
  filesFolderLayout: FilesFolderLayout;
  filesDefaultViewMode: FilesViewMode;
  filesDefaultSortKey: FilesSortKey;
  filesDefaultSortDir: FilesSortDir;
  filesShowIcons: boolean;
  filesColoredIcons: boolean;
  filesShowThumbnails: boolean;
  filesShowHiddenFiles: boolean;

  // Notifications. Sound/vibration live in the Android notification channel
  // (the OS owns them after channel creation), so there are no sound keys.
  emailNotificationsEnabled: boolean;
  calendarNotificationsEnabled: boolean;
  calendarInvitationParsingEnabled: boolean;

  // Sidebar apps
  sidebarApps: SidebarApp[];
  keepAppsLoaded: boolean;

  // Filters UI state
  filtersExpandedView: boolean;

  // Debug logging (see lib/debug.ts). Persisted like the webmail so a support
  // session survives restarts.
  debugMode: boolean;
  debugCategories: Record<DebugCategory, boolean>;

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
  includeGroupInUnified: true,

  externalContentPolicy: 'ask',
  trustedSenders: [],
  trustedSendersAddressBook: null,
  senderFavicons: true,
  hideInlineImageAttachments: true,

  groupContactsByLetter: true,
  sortContactsByLastName: false,

  theme: 'system',
  fontSize: 'medium',
  density: 'regular',
  showToolbarLabels: true,
  animationsEnabled: true,
  emailAlwaysLightMode: false,
  activeThemeId: null,

  autoSelectReplyIdentity: false,
  attachmentReminderEnabled: true,
  // Same multilingual list as the webmail so a synced/imported settings blob
  // does not flip the reminder behaviour between clients.
  attachmentReminderKeywords: [
    // English
    'attached', 'attachment', 'attachments', 'see attached', 'find attached', 'please find attached',
    // German
    'angehängt', 'anhang', 'anbei', 'im anhang',
    // French
    'ci-joint', 'pièce jointe',
    // Spanish
    'adjunto', 'adjunta', 'en adjunto',
    // Italian
    'allegato', 'in allegato',
    // Dutch
    'bijgevoegd', 'bijlage',
    // Portuguese
    'em anexo', 'anexo',
    // Polish
    'w załączniku',
    // Russian
    'во вложении',
    // Japanese
    '添付',
    // Chinese
    '附件',
    // Korean
    '첨부',
    // Latvian
    'pielikumā',
  ],
  plainTextMode: false,
  sendDelaySeconds: 0,
  signaturePosition: 'below_quote',
  signatureSeparatorEnabled: true,
  requestReadReceiptDefault: false,
  emptySubjectWarningEnabled: true,
  autoSaveDraftInterval: 60000,
  subAddressDelimiter: '+',
  preferredIdentityIds: {},

  markAsReadDelay: 0,
  deleteAction: 'trash',
  permanentlyDeleteJunk: false,
  showPreview: true,
  emailsPerPage: 25,
  mailSortAscending: false,
  disableThreading: false,
  messageListOrder: [],
  messageListOrderScope: 'inbox',
  showAvatarsInJunk: false,
  showFolderTotalCount: true,
  unifiedCrossAccount: false,
  mailAttachmentAction: 'preview',
  attachmentPosition: 'beside-sender',
  plainTextFont: 'sans',
  messageSpacing: 'auto',
  readReceiptResponse: 'ask',
  postExportAction: 'keep',

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
  calendarTimeZone: 'auto',
  showBirthdayCalendar: false,
  enableCalendarTasks: false,
  showTasksOnCalendar: true,
  sharedCalendarColors: {},

  filesFolderLayout: 'inline',
  filesDefaultViewMode: 'list',
  filesDefaultSortKey: 'name',
  filesDefaultSortDir: 'asc',
  filesShowIcons: true,
  filesColoredIcons: true,
  filesShowThumbnails: true,
  filesShowHiddenFiles: false,

  emailNotificationsEnabled: true,
  calendarNotificationsEnabled: true,
  calendarInvitationParsingEnabled: true,

  sidebarApps: [],
  keepAppsLoaded: false,

  filtersExpandedView: false,

  debugMode: false,
  debugCategories: {
    jmap: true,
    calendar: true,
    tasks: true,
    auth: true,
    filters: true,
    email: true,
    push: true,
    contacts: true,
  },

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

  // Shared-calendar color overrides
  setSharedCalendarColor: (key: string, color: string) => void;
  removeSharedCalendarColor: (key: string) => void;

  // Sidebar apps
  addSidebarApp: (app: Omit<SidebarApp, 'id'>) => void;
  updateSidebarApp: (id: string, updates: Partial<Omit<SidebarApp, 'id'>>) => void;
  removeSidebarApp: (id: string) => void;
  reorderSidebarApps: (apps: SidebarApp[]) => void;

  // Restore every persisted key to its default (keeps identities/session state).
  resetToDefaults: () => void;
  // JSON blob in the webmail's export shape (lib/settings export) so a file
  // round-trips between the two clients. See SETTINGS_KEY_MAP.
  exportSettings: () => string;
  // Returns false when the JSON is not a settings object. Unknown keys and
  // invalid values are ignored; device-local keys are never imported.
  importSettings: (json: string) => boolean;

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

const oneOf = (values: readonly unknown[]) => (v: unknown) => values.includes(v);
const intBetween = (min: number, max: number) => (v: unknown) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const stringArray = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');

export const SWIPE_ACTIONS: SwipeAction[] = ['none', 'archive', 'delete', 'spam', 'read', 'star', 'pin', 'move'];

// Per-key validators applied on hydrate and import. A value that fails falls
// back to the default rather than flowing into the UI (a corrupt
// `density: "x"` used to break every row-height lookup).
const VALIDATORS: Partial<Record<keyof PersistedSettings, (v: unknown) => boolean>> = {
  externalContentPolicy: oneOf(['allow', 'block', 'ask']),
  trustedSenders: stringArray,
  dateFormat: oneOf(['smart', 'relative', 'full']),
  timeFormat: oneOf(['12h', '24h']),
  theme: oneOf(['light', 'dark', 'system']),
  messageListOrderScope: oneOf(['inbox', 'all']),
  // Levels are sanitized by the consumer (lib/message-list-order sanitizeSortLevels).
  messageListOrder: (v) => Array.isArray(v),
  fontSize: oneOf(['small', 'medium', 'large']),
  density: oneOf(['extra-compact', 'compact', 'regular', 'comfortable']),
  attachmentReminderKeywords: stringArray,
  // Same set the webmail accepts (stores/settings-store.ts importSettings).
  sendDelaySeconds: oneOf([0, 10, 30, 60]),
  signaturePosition: oneOf(['above_quote', 'below_quote']),
  autoSaveDraftInterval: intBetween(1000, 3600000),
  // RFC 5321 atext specials minus alphanumerics and "@" (lib/sub-addressing).
  subAddressDelimiter: (v) => typeof v === 'string' && /^[!#$%&'*+\-./=?^_`{|}~]$/.test(v),
  preferredIdentityIds: (v) => !!v && typeof v === 'object' && !Array.isArray(v)
    && Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string'),
  markAsReadDelay: (v) => typeof v === 'number' && Number.isFinite(v) && v >= -1,
  deleteAction: oneOf(['trash', 'trash-and-read', 'permanent']),
  emailsPerPage: intBetween(1, 500),
  mailAttachmentAction: oneOf(['preview', 'download']),
  attachmentPosition: oneOf(['beside-sender', 'below-header']),
  plainTextFont: oneOf(['sans', 'mono']),
  messageSpacing: oneOf(['auto', 'always', 'edge']),
  readReceiptResponse: oneOf(['ask', 'always', 'never']),
  postExportAction: oneOf(['keep', 'archive', 'trash']),
  swipeLeftAction: oneOf(SWIPE_ACTIONS),
  swipeRightAction: oneOf(SWIPE_ACTIONS),
  swipeMode: oneOf(['instant', 'reveal']),
  archiveMode: oneOf(['single', 'year', 'month']),
  calendarDefaultView: oneOf(['month', 'week', 'day', 'agenda']),
  calendarFirstDayOfWeek: oneOf([0, 1]),
  calendarTimeFormat: oneOf(['12h', '24h']),
  calendarHoverPreview: oneOf(['instant', 'delay-500ms', 'delay-1s', 'delay-2s', 'off']),
  filesFolderLayout: oneOf(['inline', 'sidebar']),
  filesDefaultViewMode: oneOf(['list', 'grid']),
  filesDefaultSortKey: oneOf(['name', 'size', 'modified']),
  filesDefaultSortDir: oneOf(['asc', 'desc']),
  exportSpaceReplacement: oneOf(['keep', 'underscore', 'dash']),
  offlineCacheDays: intBetween(1, 3650),
  offlineCacheMaxMB: intBetween(1, 100000),
  sidebarApps: (v) => Array.isArray(v) && v.every((a) =>
    a && typeof a === 'object'
    && typeof (a as SidebarApp).id === 'string'
    && typeof (a as SidebarApp).name === 'string'
    && typeof (a as SidebarApp).url === 'string'),
};

export function mergeWithDefaults(parsed: Partial<PersistedSettings>): PersistedSettings {
  const out: Record<string, unknown> = { ...DEFAULT_PERSISTED };
  for (const k of PERSIST_KEYS) {
    const v = parsed[k];
    if (v === undefined || v === null) continue;
    const def = DEFAULT_PERSISTED[k];
    // Type-tolerant merge: only adopt when the basic shape matches the default
    // and the per-key validator (when there is one) accepts the value.
    const validator = VALIDATORS[k];
    if (validator && !validator(v)) continue;
    if (k === 'bottomQuickActions') {
      out[k] = normalizeBottomQuickActions(v);
    } else if (Array.isArray(def)) {
      if (Array.isArray(v)) out[k] = v;
    } else if (typeof def === 'object') {
      if (typeof v === 'object' && !Array.isArray(v)) out[k] = { ...(def as object), ...(v as object) };
    } else if (typeof def === typeof v) {
      out[k] = v;
    }
  }
  return out as unknown as PersistedSettings;
}

// RN key → webmail key for the keys whose names differ. Everything else is
// exported under its own name. Device-local keys (DEVICE_LOCAL_KEYS) are
// never exported or imported. This is also the mapping a future settings
// sync would use (see docs/parity/08-settings-push-i18n-ui.md).
export const SETTINGS_KEY_MAP: Partial<Record<keyof PersistedSettings, string>> = {
  calendarFirstDayOfWeek: 'firstDayOfWeek',
  calendarTimeZone: 'timeZone',
  calendarShowTimeInMonth: 'showTimeInMonthView',
  calendarShowWeekNumbers: 'showWeekNumbers',
  emailExportTemplate: 'emailDownloadTemplate',
  attachmentExportTemplate: 'attachmentDownloadTemplate',
  exportSpaceReplacement: 'filenameSpaceReplacement',
  exportLowercase: 'filenameLowercase',
  exportStripDiacritics: 'filenameStripDiacritics',
  filtersExpandedView: 'expandedFilterView',
};

// Keys that describe this device rather than the user's preferences.
export const DEVICE_LOCAL_KEYS: ReadonlySet<keyof PersistedSettings> = new Set<keyof PersistedSettings>([
  'swipeMode',
  'bottomQuickActions',
  'offlineCacheEnabled',
  'offlineCacheDays',
  'offlineCacheMaxMB',
  'mailSortAscending',
  'filesFolderLayout',
  'filesDefaultViewMode',
  'filesDefaultSortKey',
  'filesDefaultSortDir',
  'filesShowIcons',
  'filesColoredIcons',
  'filesShowThumbnails',
  'filesShowHiddenFiles',
  'calendarDefaultView',
]);

export function toExportShape(state: PersistedSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PERSIST_KEYS) {
    if (DEVICE_LOCAL_KEYS.has(k)) continue;
    out[SETTINGS_KEY_MAP[k] ?? k] = state[k];
  }
  return out;
}

export function fromExportShape(input: Record<string, unknown>): Partial<PersistedSettings> {
  const reverse = new Map<string, keyof PersistedSettings>();
  for (const [rnKey, webKey] of Object.entries(SETTINGS_KEY_MAP)) {
    reverse.set(webKey as string, rnKey as keyof PersistedSettings);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const rnKey = reverse.get(key) ?? (PERSIST_KEYS.includes(key as keyof PersistedSettings) ? (key as keyof PersistedSettings) : null);
    if (!rnKey || DEVICE_LOCAL_KEYS.has(rnKey)) continue;
    out[rnKey] = value;
  }
  return out as Partial<PersistedSettings>;
}

function stripDisplayName(email: string): string {
  // "Name <addr>" → addr, matching the webmail's trusted-sender normalisation.
  const trimmed = email.trim();
  const angleMatch = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
  return (angleMatch ? angleMatch[2] : trimmed).toLowerCase().trim();
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
    const normalized = stripDisplayName(email);
    if (!normalized) return;
    const current = get().trustedSenders;
    if (current.includes(normalized)) return;
    set({ trustedSenders: [...current, normalized] });
    persist(snapshot(get()));
  },

  removeTrustedSender: (email) => {
    const normalized = stripDisplayName(email);
    set({ trustedSenders: get().trustedSenders.filter((e) => e !== normalized) });
    persist(snapshot(get()));
  },

  isSenderTrusted: (email) => {
    const normalized = stripDisplayName(email);
    return get().trustedSenders.includes(normalized);
  },

  setSharedCalendarColor: (key, color) => {
    set({ sharedCalendarColors: { ...get().sharedCalendarColors, [key]: color } });
    persist(snapshot(get()));
  },

  removeSharedCalendarColor: (key) => {
    const { [key]: _removed, ...rest } = get().sharedCalendarColors;
    set({ sharedCalendarColors: rest });
    persist(snapshot(get()));
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

  resetToDefaults: () => {
    set({ ...DEFAULT_PERSISTED });
    persist(snapshot(get()));
  },

  exportSettings: () => JSON.stringify(toExportShape(snapshot(get())), null, 2),

  importSettings: (json) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const incoming = fromExportShape(parsed as Record<string, unknown>);
    // Validate against the current state so keys absent from the file keep
    // their value instead of snapping back to the default.
    const merged = mergeWithDefaults({ ...snapshot(get()), ...incoming });
    set({ ...merged });
    persist(snapshot(get()));
    return true;
  },

  reset: () => set({
    identities: [],
    loading: false,
    error: null,
  }),
}));
