import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import type { Identity } from '../api/types';
import { getIdentities as fetchIdentities } from '../api/identity';
import { jmapClient } from '../api/jmap-client';
import { generateAccountId } from '../lib/account-utils';
import { writeIdentityCache } from '../lib/identity-cache';
import type { SortLevel, MessageListOrderScope } from '../lib/message-list-order';
import { isValidHourPair, isValidWorkingDays } from '../lib/calendar-display-range';
import { sanitizeSidebarAppUrl } from '../lib/sidebar-app-url';
import {
  exportableCalendarColors,
  importedCalendarColors,
  isLegacyCalendarColorKey,
  readsLegacyCalendarColors,
  withoutAccountCalendarColors,
  withoutLegacyCalendarColors,
} from '../lib/calendar-color-keys';

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
// With autoSelectReplyIdentity on: 'exact' = configured identities only,
// 'domain' = also same-domain catch-all addresses (rewrites From), #1000.
export type ReplyIdentityMatch = 'exact' | 'domain';
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
// How numeric dates are ordered, independent of the language (webmail
// `dateLocale`): `auto` follows the language, `iso` is YYYY-MM-DD, `en-GB`
// day/month/year and `en-US` month/day/year.
export type DateLocale = 'auto' | 'iso' | 'en-GB' | 'en-US';
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
// The app accounts signed in while the old-colour readers were unseeded
// (legacyCalendarColorNonReaders). A row of its own, not in the settings:
// a sign-in after a failed settings read must still be recorded.
const LEGACY_COLOR_NON_READERS_KEY = 'bulwark:calendar-color-non-readers:v1';

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
  // null = not decided yet and treated as on (isTrustedSendersSyncOn);
  // false = the user turned it off in Content & Senders.
  trustedSendersAddressBook: boolean | null;
  senderFavicons: boolean;
  hideInlineImageAttachments: boolean;

  // Language, region & time
  dateFormat: DateFormat;
  dateLocale: DateLocale;
  timeFormat: TimeFormat;

  // Unified inbox: also pull in group/shared inboxes reachable through each
  // logged-in account (parity with the webmail `includeGroupInUnified` setting).
  includeGroupInUnified: boolean;

  // Tags: nest tags under other tags and show them as a tree (webmail
  // `nestedTags`, off by default there too).
  nestedTags: boolean;

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
  replyIdentityMatch: ReplyIdentityMatch;
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
  // Typing "@" in the rich body offers the To and Cc recipients.
  recipientMentionsEnabled: boolean;
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
  // Offer the code of a sign-in or confirmation mail as a copy chip.
  showVerificationCodes: boolean;
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
  // Tint the drawer's role icons (blue Inbox, red Junk…); off gives a
  // monochrome drawer. Same key and default as the webmail.
  colorfulSidebarIcons: boolean;
  // Opening a folder drops an active search and filters and browses it,
  // instead of re-running the search there (#553, the default).
  clearSearchOnFolderChange: boolean;
  // App only: reopen the folder last viewed on start instead of the Inbox.
  restoreLastFolder: boolean;
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
  // Scroll continuously through months, weeks and days (#759) instead of
  // one period at a time. Same key as the webmail's setting.
  calendarFreeScroll: boolean;
  calendarHoverPreview: CalendarHoverPreview;
  // Draw only calendarDayStartHour..calendarDayEndHour in the day and week
  // views (webmail #1164). Same keys as the webmail's settings.
  calendarLimitHours: boolean;
  calendarDayStartHour: number;
  calendarDayEndHour: number;
  // Leave the days missing from calendarWorkingDays out of the week view.
  calendarHideNonWorkingDays: boolean;
  // Weekdays as Date.getDay numbers (0 = Sunday).
  calendarWorkingDays: number[];
  // IANA zone the whole app shows and picks times in, or 'auto' to follow the
  // device (#755); set under Language & region. Same key semantics as the
  // webmail's `timeZone` setting.
  calendarTimeZone: string;
  showBirthdayCalendar: boolean;
  // Hex colour of the virtual birthday calendar (webmail's key and default).
  birthdayCalendarColor: string;
  enableCalendarTasks: boolean;
  showTasksOnCalendar: boolean;
  // Per-viewer color overrides for shared calendars, keyed by
  // sharedCalendarColorKey(). Lets the user recolor calendars shared with
  // them without changing the owner's color (parity with webmail #345).
  sharedCalendarColors: Record<string, string>;
  // The app accounts that may still read the old, account-less colour keys
  // (legacySharedCalendarColorKey): those registered at the upgrade, each
  // until its first full calendar load claims them. Null until seeded
  // (seedLegacyCalendarColorReaders). Device-local: it names this device's
  // accounts.
  legacyCalendarColorReaders: string[] | null;

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
  // Only push for mail that lands in the Inbox (webmail's inbox_only).
  pushNotifyInboxOnly: boolean;
  calendarNotificationsEnabled: boolean;
  calendarInvitationParsingEnabled: boolean;
  // Inbox unread count on the app icon (iOS, see lib/app-badge). Same
  // preference as the webmail's `faviconUnreadBadge` (tab and app icon).
  appIconUnreadBadge: boolean;

  // Sidebar apps
  sidebarApps: SidebarApp[];
  keepAppsLoaded: boolean;

  // Filters UI state
  filtersExpandedView: boolean;

  // Files: the storage notice at the Files root, once dismissed, stays dismissed.
  filesStabilityNoticeDismissed: boolean;

  // Screen protection (Android). Block screenshots sets FLAG_SECURE, which
  // also blanks the recent-apps preview; hide in recents blanks only the
  // preview (API 33+). The native side keeps a copy so a cold start is
  // covered before these hydrate.
  blockScreenshots: boolean;
  hideInRecents: boolean;

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
  dateLocale: 'auto',
  timeFormat: '24h',
  includeGroupInUnified: true,

  externalContentPolicy: 'ask',
  trustedSenders: [],
  trustedSendersAddressBook: null,
  senderFavicons: true,
  hideInlineImageAttachments: true,

  nestedTags: false,

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
  replyIdentityMatch: 'domain',
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
  recipientMentionsEnabled: true,
  autoSaveDraftInterval: 60000,
  subAddressDelimiter: '+',
  preferredIdentityIds: {},

  markAsReadDelay: 0,
  deleteAction: 'trash',
  permanentlyDeleteJunk: false,
  showPreview: true,
  showVerificationCodes: true,
  emailsPerPage: 25,
  mailSortAscending: false,
  disableThreading: false,
  messageListOrder: [],
  messageListOrderScope: 'inbox',
  showAvatarsInJunk: false,
  showFolderTotalCount: true,
  colorfulSidebarIcons: true,
  clearSearchOnFolderChange: false,
  restoreLastFolder: false,
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
  calendarFreeScroll: true,
  calendarHoverPreview: 'delay-500ms',
  calendarLimitHours: true,
  calendarDayStartHour: 8,
  calendarDayEndHour: 20,
  calendarHideNonWorkingDays: false,
  calendarWorkingDays: [1, 2, 3, 4, 5],
  calendarTimeZone: 'auto',
  showBirthdayCalendar: false,
  birthdayCalendarColor: '#eab308',
  enableCalendarTasks: false,
  showTasksOnCalendar: true,
  sharedCalendarColors: {},
  legacyCalendarColorReaders: null,

  filesFolderLayout: 'inline',
  filesDefaultViewMode: 'list',
  filesDefaultSortKey: 'name',
  filesDefaultSortDir: 'asc',
  filesShowIcons: true,
  filesColoredIcons: true,
  filesShowThumbnails: true,
  filesShowHiddenFiles: false,

  emailNotificationsEnabled: true,
  pushNotifyInboxOnly: false,
  calendarNotificationsEnabled: true,
  calendarInvitationParsingEnabled: true,
  appIconUnreadBadge: true,

  sidebarApps: [],
  keepAppsLoaded: false,

  filtersExpandedView: false,

  filesStabilityNoticeDismissed: false,

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

  blockScreenshots: false,
  hideInRecents: false,

  offlineCacheEnabled: false,
  offlineCacheDays: 7,
  offlineCacheMaxMB: 50,
};

export interface SettingsState extends PersistedSettings {
  identities: Identity[];
  /** The signed-in account (server, login, JMAP account) `identities` were read for. */
  identitiesFor: string | null;
  loading: boolean;
  error: string | null;
  hydrated: boolean;
  // The stored settings were there but could not be read (a failed read,
  // corrupt JSON, not an object): the defaults stand in for them, so nothing
  // is written until a read succeeds (see editSettings). No stored settings
  // at all is a clean read.
  settingsReadFailed: boolean;
  // App accounts signed in while legacyCalendarColorReaders was still null
  // (the seed skipped at a start whose registry or settings failed to read):
  // they are new, so never readers, though a later seed finds them
  // registered. Device-local, in its own row.
  legacyCalendarColorNonReaders: string[];
  // That row was there but could not be read: the seed waits for a start
  // that reads it, and the row is not written over.
  legacyCalendarColorNonReadersReadFailed: boolean;

  /** Read the identities; concurrent calls share one request. */
  fetchIdentities: () => Promise<void>;
  /**
   * Read the identities only when they are not held for the signed-in account
   * yet. An account without identities is not asked again on every call.
   */
  ensureIdentities: () => Promise<void>;
  /**
   * Re-read identities already held for the signed-in account (the server
   * side may have added or removed one). Silent: no loading flag, errors and
   * the old list are left alone. Does nothing for an account never loaded.
   */
  refreshIdentities: () => Promise<void>;
  hydrate: () => Promise<void>;
  /** After a failed read: read the stored settings again, and on success apply the edits made meanwhile and write. */
  retryReadSettings: () => Promise<void>;

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
  /** Drop a signed-out app account's shared calendar colours and its right to the old keys (which go with the last reader). */
  forgetAccountCalendarColors: (appAccountId: string) => Promise<void>;
  /** Once only: the accounts registered now may read the old colour keys (none if there are none). */
  seedLegacyCalendarColorReaders: (appAccountIds: readonly string[]) => void;
  /** Store an account's claimed old colours and stop it reading the old keys. */
  finishLegacyCalendarColors: (appAccountId: string, claimed: Record<string, string>) => void;
  /** A sign-in registered a new app account: while the readers are unseeded, it never becomes one. */
  noteSignedInWhileColorReadersUnseeded: (appAccountId: string) => Promise<void>;

  // Sidebar apps
  addSidebarApp: (app: Omit<SidebarApp, 'id'>) => void;
  updateSidebarApp: (id: string, updates: Partial<Omit<SidebarApp, 'id'>>) => void;
  removeSidebarApp: (id: string) => void;
  reorderSidebarApps: (apps: SidebarApp[]) => void;

  // Restore every persisted key to its default (keeps identities/session state).
  resetToDefaults: () => void;
  // JSON blob in the webmail's export shape (lib/settings export) so a file
  // round-trips between the two clients. See SETTINGS_KEY_MAP.
  /** The settings file, with app account `appAccountId`'s shared calendar colours (and no other's). */
  exportSettings: (appAccountId?: string | null) => string;
  // Returns false when the JSON is not a settings object. Unknown keys and
  // invalid values are ignored; device-local keys are never imported.
  // Shared calendar colours in the file go to app account `appAccountId`
  // only (importedCalendarColors), none without one.
  importSettings: (json: string, appAccountId?: string | null) => boolean;

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
  dateLocale: oneOf(['auto', 'iso', 'en-GB', 'en-US']),
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
  replyIdentityMatch: oneOf(['exact', 'domain']),
  autoSaveDraftInterval: intBetween(1000, 3600000),
  // RFC 5321 atext specials minus alphanumerics and "@" (lib/sub-addressing).
  subAddressDelimiter: (v) => typeof v === 'string' && /^[!#$%&'*+\-./=?^_`{|}~]$/.test(v),
  legacyCalendarColorReaders: stringArray,
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
  calendarFirstDayOfWeek: oneOf([0, 1, 6]),
  calendarTimeFormat: oneOf(['12h', '24h']),
  calendarHoverPreview: oneOf(['instant', 'delay-500ms', 'delay-1s', 'delay-2s', 'off']),
  calendarDayStartHour: intBetween(0, 23),
  calendarDayEndHour: intBetween(1, 24),
  calendarWorkingDays: isValidWorkingDays,
  birthdayCalendarColor: (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v),
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

// The string-valued entries of a settings file's shared calendar colours.
function importableCalendarColors(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).filter(([, c]) => typeof c === 'string')) as Record<string, string>;
}

// `appAccountId` taken off the old colour key readers, over `overrides`;
// the old keys go with the last reader.
function withoutLegacyReader(
  overrides: Record<string, string>,
  readers: readonly string[],
  appAccountId: string,
): Pick<PersistedSettings, 'sharedCalendarColors' | 'legacyCalendarColorReaders'> {
  const left = readers.filter((id) => id !== appAccountId);
  return {
    legacyCalendarColorReaders: left,
    sharedCalendarColors: left.length ? overrides : withoutLegacyCalendarColors(overrides),
  };
}

function importableSidebarApps(apps: readonly unknown[]): SidebarApp[] {
  const out: SidebarApp[] = [];
  for (const a of apps) {
    if (!a || typeof a !== 'object') continue;
    const app = a as SidebarApp;
    if (typeof app.id !== 'string' || typeof app.name !== 'string' || typeof app.url !== 'string') continue;
    const url = sanitizeSidebarAppUrl(app.url);
    if (url) out.push({ ...app, url });
  }
  return out;
}

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
    } else if (k === 'legacyCalendarColorReaders') {
      // Its default (null) has no shape to match; the validator checked it.
      out[k] = v;
    } else if (Array.isArray(def)) {
      if (Array.isArray(v)) out[k] = v;
    } else if (typeof def === 'object') {
      if (typeof v === 'object' && !Array.isArray(v)) out[k] = { ...(def as object), ...(v as object) };
    } else if (typeof def === typeof v) {
      out[k] = v;
    }
  }
  // The two hours only make sense together: a persisted pair that is not
  // 0 <= start < end <= 24 goes back to the defaults as a pair.
  if (parsed.calendarDayStartHour != null || parsed.calendarDayEndHour != null) {
    const start = parsed.calendarDayStartHour ?? DEFAULT_PERSISTED.calendarDayStartHour;
    const end = parsed.calendarDayEndHour ?? DEFAULT_PERSISTED.calendarDayEndHour;
    out.calendarDayStartHour = isValidHourPair(start, end) ? start : DEFAULT_PERSISTED.calendarDayStartHour;
    out.calendarDayEndHour = isValidHourPair(start, end) ? end : DEFAULT_PERSISTED.calendarDayEndHour;
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
  appIconUnreadBadge: 'faviconUnreadBadge',
};

// Keys that describe this device rather than the user's preferences.
export const DEVICE_LOCAL_KEYS: ReadonlySet<keyof PersistedSettings> = new Set<keyof PersistedSettings>([
  'swipeMode',
  'bottomQuickActions',
  'offlineCacheEnabled',
  'offlineCacheDays',
  'offlineCacheMaxMB',
  'mailSortAscending',
  'restoreLastFolder',
  'filesFolderLayout',
  'filesDefaultViewMode',
  'filesDefaultSortKey',
  'filesDefaultSortDir',
  'filesShowIcons',
  'filesColoredIcons',
  'filesShowThumbnails',
  'filesShowHiddenFiles',
  'filesStabilityNoticeDismissed',
  'calendarDefaultView',
  'blockScreenshots',
  'hideInRecents',
  'legacyCalendarColorReaders',
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

// Which signed-in account the identities belong to. Two servers can hand out
// the same JMAP account ids, so the server and login are part of it.
export function identityScope(): string | null {
  try {
    return `${jmapClient.serverUrl ?? ''}|${jmapClient.username ?? ''}|${jmapClient.accountId}`;
  } catch {
    return null;
  }
}

// The app account (registry id) the client is signed in to, which keys the
// offline identity cache; null when the login is not known.
function identityCacheAccount(): string | null {
  const { username, serverUrl } = jmapClient;
  return username && serverUrl ? generateAccountId(username, serverUrl) : null;
}

let hydrateInFlight: Promise<void> | null = null;

type NonReadersRead = { ok: true; ids: string[] } | { ok: false };

async function readLegacyColorNonReaders(): Promise<NonReadersRead> {
  try {
    const raw = await AsyncStorage.getItem(LEGACY_COLOR_NON_READERS_KEY);
    if (!raw) return { ok: true, ids: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!stringArray(parsed)) throw new Error('stored non-readers are not a list of ids');
    return { ok: true, ids: parsed as string[] };
  } catch (err) {
    console.warn('[settings-store] calendar colour non-readers read failed', err);
    return { ok: false };
  }
}

type ReadResult = { ok: true; settings: PersistedSettings | null } | { ok: false };

// The stored settings, merged over the defaults; null when there are none.
// Not ok when the row is there but cannot be read or is not an object.
async function readStoredSettings(): Promise<ReadResult> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return { ok: true, settings: null };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('stored settings are not an object');
    return { ok: true, settings: mergeWithDefaults(parsed as Partial<PersistedSettings>) };
  } catch (err) {
    console.warn('[settings-store] hydrate failed', err);
    return { ok: false };
  }
}

// A change to the settings, worked out from the state it is given (null for
// none). Kept while the stored settings could not be read, to run again on
// them once they read.
type SettingsEdit = (state: SettingsState) => Partial<PersistedSettings> | null;
let editsWhileUnread: SettingsEdit[] = [];

/** Test-only: forget the edits held since a failed read. */
export function discardSettingsEditsForTests(): void {
  editsWhileUnread = [];
}

// Every settings write goes through here. After a failed read the defaults
// stand in for the stored settings, and writing them would replace every
// stored setting (the auto-assigned calendar colours, a trusted sender added
// by the Outbox replay, any edit). So nothing is written then: the edit shows
// at once, is kept, and the read is tried again. When it works, the kept
// edits run again on the stored settings and are written (retryReadSettings).
// Re-running them is safe because each is worked out from the state it is
// given; keeping them only in memory means an app killed first loses them,
// which is still better than losing everything stored.
function editSettings(change: SettingsEdit): void {
  const store = useSettingsStore;
  const patch = change(store.getState());
  if (patch) store.setState(patch);
  if (!store.getState().settingsReadFailed) {
    if (patch) persist(snapshot(store.getState()));
    return;
  }
  // Kept even when it changes nothing over the defaults: on the stored
  // settings it may (a forgotten account's colours).
  if (editsWhileUnread.length === 0) console.warn('[settings-store] settings could not be read; changes are kept until they can');
  editsWhileUnread.push(change);
  void store.getState().retryReadSettings();
}

let retriesOnForeground = false;
function retryOnForeground(): void {
  if (retriesOnForeground) return;
  retriesOnForeground = true;
  AppState.addEventListener('change', (next) => {
    if (next === 'active') void useSettingsStore.getState().retryReadSettings();
  });
}

let identitiesInFlight: { scope: string | null; promise: Promise<void> } | null = null;

export const useSettingsStore = create<SettingsState>((set, get) => ({
  ...DEFAULT_PERSISTED,
  identities: [],
  identitiesFor: null,
  loading: false,
  error: null,
  hydrated: false,
  settingsReadFailed: false,
  legacyCalendarColorNonReaders: [],
  legacyCalendarColorNonReadersReadFailed: false,

  fetchIdentities: () => {
    const scope = identityScope();
    if (identitiesInFlight && identitiesInFlight.scope === scope) return identitiesInFlight.promise;
    const cacheAccount = identityCacheAccount();
    let promise: Promise<void> | undefined;
    promise = (async () => {
      set({ loading: true, error: null });
      try {
        const identities = await fetchIdentities();
        // Signed in to another account meanwhile: these are not its identities.
        if (identityScope() !== scope) {
          set({ loading: false });
          return;
        }
        set({ identities, identitiesFor: scope, loading: false });
        // Lets a composer opened offline still send from these.
        if (scope !== null && cacheAccount) await writeIdentityCache(cacheAccount, identities);
      } catch (err) {
        set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load identities' });
      } finally {
        if (identitiesInFlight?.promise === promise) identitiesInFlight = null;
      }
    })();
    identitiesInFlight = { scope, promise };
    return promise;
  },

  ensureIdentities: () => {
    const scope = identityScope();
    const held = get().identitiesFor;
    if (scope !== null && held === scope) return Promise.resolve();
    // Another account's identities must not stand in (the quick reply would
    // send through one this account does not have).
    if (held !== null && held !== scope) set({ identities: [], identitiesFor: null });
    return get().fetchIdentities();
  },

  refreshIdentities: async () => {
    const scope = identityScope();
    if (scope === null || get().identitiesFor !== scope) return;
    const cacheAccount = identityCacheAccount();
    try {
      const identities = await fetchIdentities();
      // Another account, or a reset, meanwhile: not ours to write.
      if (identityScope() !== scope || get().identitiesFor !== scope) return;
      set({ identities });
      if (cacheAccount) await writeIdentityCache(cacheAccount, identities);
    } catch {
      // Background refresh: keep the list we have.
    }
  },

  hydrate: () => {
    if (get().hydrated) return Promise.resolve();
    // One load for every caller: a second read finishing after the user
    // changed a setting would put the stored value back.
    if (hydrateInFlight) return hydrateInFlight;
    const promise = (async () => {
      const [read, nonReaders] = await Promise.all([readStoredSettings(), readLegacyColorNonReaders()]);
      // Ids noted before this read (a sign-in racing the start) are kept.
      set({
        legacyCalendarColorNonReaders: nonReaders.ok
          ? [...new Set([...nonReaders.ids, ...get().legacyCalendarColorNonReaders])]
          : get().legacyCalendarColorNonReaders,
        legacyCalendarColorNonReadersReadFailed: !nonReaders.ok,
      });
      if (read.ok) {
        set({ ...(read.settings ?? {}), hydrated: true, settingsReadFailed: false });
        return;
      }
      set({ hydrated: true, settingsReadFailed: true });
      retryOnForeground();
    })().finally(() => { hydrateInFlight = null; });
    hydrateInFlight = promise;
    return promise;
  },

  retryReadSettings: () => {
    if (!get().settingsReadFailed) return Promise.resolve();
    if (hydrateInFlight) return hydrateInFlight;
    const promise = (async () => {
      const read = await readStoredSettings();
      if (!read.ok || !get().settingsReadFailed) return;
      // The edits made meanwhile run again on what is stored, in order: an
      // edit is a change to the state, not the value it produced over the
      // defaults, so a trusted sender added meanwhile joins the stored list
      // instead of replacing it.
      const edits = editsWhileUnread;
      editsWhileUnread = [];
      let next: SettingsState = { ...get(), ...(read.settings ?? DEFAULT_PERSISTED) };
      for (const change of edits) {
        const patch = change(next);
        if (patch) next = { ...next, ...patch };
      }
      set({ ...snapshot(next), settingsReadFailed: false });
      if (edits.length) persist(snapshot(get()));
    })().finally(() => { hydrateInFlight = null; });
    hydrateInFlight = promise;
    return promise;
  },

  updateSetting: (key, value) => editSettings(() => ({ [key]: value } as Partial<PersistedSettings>)),

  setExternalContentPolicy: (policy) => editSettings(() => ({ externalContentPolicy: policy })),
  setSenderFavicons: (enabled) => editSettings(() => ({ senderFavicons: enabled })),
  setGroupContactsByLetter: (enabled) => editSettings(() => ({ groupContactsByLetter: enabled })),
  setTheme: (theme) => editSettings(() => ({ theme })),
  setFontSize: (fontSize) => editSettings(() => ({ fontSize })),
  setDensity: (density) => editSettings(() => ({ density })),
  setShowToolbarLabels: (enabled) => editSettings(() => ({ showToolbarLabels: enabled })),
  setAnimationsEnabled: (enabled) => editSettings(() => ({ animationsEnabled: enabled })),
  setEmailAlwaysLightMode: (enabled) => editSettings(() => ({ emailAlwaysLightMode: enabled })),
  setAutoSelectReplyIdentity: (enabled) => editSettings(() => ({ autoSelectReplyIdentity: enabled })),
  setAttachmentReminderEnabled: (enabled) => editSettings(() => ({ attachmentReminderEnabled: enabled })),
  setAttachmentReminderKeywords: (keywords) => editSettings(() => ({ attachmentReminderKeywords: keywords })),
  setSwipeLeftAction: (action) => editSettings(() => ({ swipeLeftAction: action })),
  setSwipeRightAction: (action) => editSettings(() => ({ swipeRightAction: action })),
  setSwipeMode: (mode) => editSettings(() => ({ swipeMode: mode })),
  setArchiveMode: (mode) => editSettings(() => ({ archiveMode: mode })),

  addTrustedSender: (email) => {
    const normalized = stripDisplayName(email);
    if (!normalized) return;
    editSettings((s) => (s.trustedSenders.includes(normalized) ? null : { trustedSenders: [...s.trustedSenders, normalized] }));
  },

  removeTrustedSender: (email) => {
    const normalized = stripDisplayName(email);
    editSettings((s) => ({ trustedSenders: s.trustedSenders.filter((e) => e !== normalized) }));
  },

  isSenderTrusted: (email) => {
    const normalized = stripDisplayName(email);
    return get().trustedSenders.includes(normalized);
  },

  setSharedCalendarColor: (key, color) => editSettings((s) => ({ sharedCalendarColors: { ...s.sharedCalendarColors, [key]: color } })),

  removeSharedCalendarColor: (key) => editSettings((s) => {
    const { [key]: _removed, ...rest } = s.sharedCalendarColors;
    return { sharedCalendarColors: rest };
  }),

  forgetAccountCalendarColors: async (appAccountId) => {
    // Read the stored settings first: a write before that would put the
    // defaults over every other setting.
    await get().hydrate();
    // After a failed read this runs again on the stored row once it reads
    // (editSettings), so the account's colours still go.
    editSettings((s) => {
      const current = s.sharedCalendarColors;
      const readers = s.legacyCalendarColorReaders;
      const wasReader = !!appAccountId && !!readers?.includes(appAccountId);
      const kept = withoutAccountCalendarColors(current, appAccountId);
      if (kept === current && !wasReader) return null;
      return wasReader ? withoutLegacyReader(kept, readers!, appAccountId) : { sharedCalendarColors: kept };
    });
  },

  seedLegacyCalendarColorReaders: (appAccountIds) => {
    if (get().legacyCalendarColorReaders !== null) return;
    // The stored settings could not be read: seeding would write the
    // defaults over them. Left for a launch that reads them.
    if (get().settingsReadFailed) return;
    // Nor without the accounts signed in while unseeded: they would be
    // taken for accounts registered at the upgrade.
    if (get().legacyCalendarColorNonReadersReadFailed) return;
    const nonReaders = get().legacyCalendarColorNonReaders;
    const overrides = get().sharedCalendarColors;
    const anyLegacy = Object.keys(overrides).some(isLegacyCalendarColorKey);
    const readers = anyLegacy ? appAccountIds.filter((id) => !!id && !nonReaders.includes(id)) : [];
    // No account registered to claim them: they go now.
    editSettings(() => ({
      legacyCalendarColorReaders: readers,
      sharedCalendarColors: readers.length ? overrides : withoutLegacyCalendarColors(overrides),
    }));
  },

  finishLegacyCalendarColors: (appAccountId, claimed) => {
    const readers = get().legacyCalendarColorReaders;
    // Not a reader (finished already, or registered later): it may claim nothing.
    // Never after a failed read either: the claim was made from the
    // defaults, so run again on the stored row it would drop the reader
    // with nothing claimed. (The readers are null then, so this is moot.)
    if (!appAccountId || !readers?.includes(appAccountId) || get().settingsReadFailed) return;
    editSettings((s) => withoutLegacyReader({ ...s.sharedCalendarColors, ...claimed }, readers, appAccountId));
  },

  noteSignedInWhileColorReadersUnseeded: async (appAccountId) => {
    // Its own row is read with the settings; never written before that.
    await get().hydrate();
    const { legacyCalendarColorReaders, legacyCalendarColorNonReaders: held } = get();
    // Once seeded, an account added later is not a reader anyway.
    if (!appAccountId || legacyCalendarColorReaders !== null || held.includes(appAccountId)) return;
    const ids = [...held, appAccountId];
    set({ legacyCalendarColorNonReaders: ids });
    // Never over a row that could not be read (it would lose the ids there);
    // the seed waits while it can't be read, so this session is still safe.
    if (get().legacyCalendarColorNonReadersReadFailed) return;
    // Kept for good: a later seed must still leave these out.
    await AsyncStorage.setItem(LEGACY_COLOR_NON_READERS_KEY, JSON.stringify(ids)).catch((err) => {
      console.warn('[settings-store] calendar colour non-readers write failed', err);
    });
  },

  addSidebarApp: (app) => {
    const id = `app-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    editSettings((s) => ({ sidebarApps: [...s.sidebarApps, { ...app, id }] }));
  },

  updateSidebarApp: (id, updates) => editSettings((s) => ({
    sidebarApps: s.sidebarApps.map((a) => (a.id === id ? { ...a, ...updates } : a)),
  })),

  removeSidebarApp: (id) => editSettings((s) => ({ sidebarApps: s.sidebarApps.filter((a) => a.id !== id) })),

  reorderSidebarApps: (apps) => editSettings(() => ({ sidebarApps: apps })),

  resetToDefaults: () => editSettings(() => ({ ...DEFAULT_PERSISTED })),

  // Only that app account's shared calendar colours, and the old keys while
  // it may still read them (exportableCalendarColors).
  exportSettings: (appAccountId = null) => {
    const state = snapshot(get());
    const sharedCalendarColors = exportableCalendarColors(
      state.sharedCalendarColors, appAccountId,
      readsLegacyCalendarColors(state.legacyCalendarColorReaders, appAccountId ?? '', get().legacyCalendarColorNonReaders),
    );
    return JSON.stringify(toExportShape({ ...state, sharedCalendarColors }), null, 2);
  },

  importSettings: (json, appAccountId = null) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const incoming = fromExportShape(parsed as Record<string, unknown>);
    // An imported app is opened later, so one whose URL fails the check is
    // dropped here rather than the whole list; the rest of the file still
    // imports. Hydrate does not filter, so an app saved before the check
    // stays editable.
    if (Array.isArray(incoming.sidebarApps)) incoming.sidebarApps = importableSidebarApps(incoming.sidebarApps);
    // The file's colours name no app account: they become the shown
    // account's, and never replace another account's (importedCalendarColors).
    const fileColors = importableCalendarColors(incoming.sharedCalendarColors);
    delete incoming.sharedCalendarColors;
    // Validate against the current state so keys absent from the file keep
    // their value instead of snapping back to the default.
    editSettings((s) => {
      const merged = mergeWithDefaults({ ...snapshot(s), ...incoming });
      merged.sharedCalendarColors = importedCalendarColors(merged.sharedCalendarColors, fileColors, appAccountId);
      return merged;
    });
    return true;
  },

  reset: () => set({
    identities: [],
    identitiesFor: null,
    loading: false,
    error: null,
  }),
}));
