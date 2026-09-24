// Settings search index: which translation keys each Settings pane renders,
// extra keywords per pane, and the walker that turns those keys into tappable
// sub-results. Ported from the webmail's lib/settings-search.ts, adapted to
// the native panes:
//   - the paths list what the RN panes show, which is not always what the
//     webmail panes show (the settings live in different panes, and many
//     webmail-only settings don't exist here);
//   - the walker prefers the `*_mobile` label/description variants the RN
//     panes render;
//   - it collects translation keys rather than strings, so every label goes
//     through t() for the current locale, with the English fallback.
// Kept free of React so it can be unit-tested.

export type SettingsTabId =
  | 'account' | 'language' | 'notifications'
  | 'appearance' | 'layout'
  | 'reading' | 'composing' | 'identities' | 'vacation'
  | 'filters' | 'templates' | 'folders' | 'keywords' | 'downloads'
  | 'security' | 'encryption' | 'content_senders'
  | 'calendar' | 'contacts' | 'files' | 'sidebar_apps'
  | 'about_data' | 'themes' | 'plugins' | 'updates' | 'debug';

// Translation paths per pane. A path may point at a whole namespace, at one
// setting's object ({ label, description, ...options }) or at a single label
// string. Everything below a path feeds the pane's full-text haystack.
export const SETTINGS_SEARCH_PATHS: Record<SettingsTabId, string[]> = {
  account: [
    'settings.account.name_label',
    'settings.account.email',
    'settings.account.username_label',
    'settings.account.auth_method_label',
    'settings.account.server',
    'settings.account.storage',
    'settings.account.accounts',
    'settings.account.shared_accounts',
  ],
  language: [
    'settings.appearance.language',
    'settings.language_region.date_format',
    'settings.language_region.time_format',
  ],
  notifications: [
    'settings.notifications.push.title',
    'settings.notifications.push.enable',
    'settings.notifications.push.transport_label',
    'settings.notifications.push.up_distributor_label',
    'settings.notifications.push.relay_label',
    'settings.notifications.push.devices_title',
    'settings.notifications.email.title',
    'settings.notifications.email.enabled',
    'settings.notifications.email.app_icon_badge',
    'settings.notifications.calendar.title',
    'settings.notifications.calendar.enabled',
    'settings.notifications.calendar.invitation_parsing',
  ],
  appearance: [
    'settings.appearance.theme',
    'settings.appearance.font_size',
    'settings.appearance.list_density',
    'settings.appearance.toolbar_labels',
    'settings.appearance.animations',
  ],
  layout: [
    'settings.layout.quick_actions',
    'settings.email_behavior.swipe_left_action',
    'settings.email_behavior.swipe_right_action',
    'settings.layout.swipe_mode',
    'settings.message_list_order',
    'settings.layout.show_folder_total_count',
    'settings.layout.show_avatars_in_junk',
    'settings.layout.unified_cross_account',
  ],
  reading: [
    'settings.email_behavior.mark_read',
    'settings.email_behavior.delete_action',
    'settings.email_behavior.archive_mode',
    'settings.email_behavior.permanently_delete_junk',
    'settings.email_behavior.show_preview',
    'settings.email_behavior.disable_threading',
    'settings.appearance.unified_mailbox.include_group',
    'settings.email_behavior.message_spacing',
    'settings.email_behavior.plain_text_font',
    'settings.email_behavior.read_receipt_response',
    'settings.email_behavior.attachment_click_action',
    'settings.email_behavior.attachment_position',
    'settings.email_behavior.hide_inline_image_attachments',
    'settings.email_behavior.emails_per_page',
    'settings.email_behavior.clear_search_on_folder_change',
  ],
  composing: [
    'settings.email_behavior.auto_select_reply_identity',
    'settings.email_behavior.reply_identity_match',
    'settings.email_behavior.plain_text_mode',
    'settings.email_behavior.request_read_receipt',
    'settings.email_behavior.empty_subject_warning',
    'settings.email_behavior.signature_separator',
    'settings.email_behavior.signature_position',
    'settings.email_behavior.send_delay',
    'settings.composer.autosave',
    'settings.email_behavior.sub_address_delimiter.label',
    'settings.email_behavior.attachment_reminder',
  ],
  identities: [
    'settings.identities.title',
    'settings.identities.display_name',
    'settings.identities.email_address',
    'identities.form.reply_to_label',
    'identities.form.bcc_label',
    'identities.form.text_signature_label',
    'identities.form.html_signature_label',
  ],
  vacation: ['settings.vacation'],
  filters: [
    'settings.filters.title',
    'settings.filters.add_rule',
    'settings.filters.expanded_view',
    'settings.filters.vacation_active',
    'settings.filters.open_sieve_editor',
  ],
  templates: ['settings.templates.title', 'settings.templates.export_import'],
  folders: ['settings.folders.title', 'settings.folders.new_folder', 'settings.folders.role'],
  keywords: [
    'settings.keywords.title',
    'settings.keywords.add_keyword',
    'settings.keywords.discover.scan',
    'settings.keywords.reset_defaults',
  ],
  downloads: [
    'settings.downloads.email_template',
    'settings.downloads.attachment_template',
    'settings.downloads.transform_title',
    'settings.downloads.spaces',
    'settings.downloads.lowercase',
    'settings.downloads.strip_diacritics',
    'settings.downloads.after_export',
  ],
  security: [
    'settings.security.client_cert',
    'settings.security.password',
    'settings.security.display_name',
    'settings.security.two_factor.section_title',
    'settings.security.two_factor',
    'settings.security.app_passwords.title',
    'settings.security.app_passwords.name_label',
    'settings.security.api_keys',
    'settings.security.email_client',
    'settings.security.public_keys',
    'settings.security.encryption.section_title',
    'settings.security.encryption.algorithm_label',
    'settings.security.encryption.encrypt_on_append',
    'settings.security.encryption.allow_spam_training',
  ],
  encryption: ['settings.smime'],
  content_senders: [
    'settings.email_behavior.external_content',
    'settings.email_behavior.always_light_mode',
    'settings.email_behavior.trusted_senders',
  ],
  calendar: [
    'calendar.settings.default_view',
    'calendar.settings.week_starts_on',
    'calendar.settings.time_format',
    'calendar.settings.time_zone',
    'calendar.settings.show_time_in_month_view',
    'calendar.settings.show_week_numbers',
    'calendar.settings.show_birthday_calendar',
    'calendar.settings.enable_tasks',
    'calendar.settings.show_tasks_on_calendar',
  ],
  contacts: [
    'settings.contacts.group_by_letter_label',
    'settings.contacts.sort_by_last_name_label',
    'settings.contacts.import_label',
    'settings.contacts.export_label',
    'settings.contacts.manage_title',
  ],
  files: [
    'files.settings_display',
    'files.settings_default_view',
    'files.settings_default_sort',
    'files.settings_sort_direction',
    'files.settings_icons',
    'files.settings_show_icons',
    'files.settings_colored_icons',
    'files.settings_show_thumbnails',
    'files.settings_behavior',
    'files.settings_show_hidden',
  ],
  sidebar_apps: [
    'settings.sidebar_apps.keep_loaded',
    'settings.sidebar_apps.manage_title',
    'settings.sidebar_apps.add',
  ],
  about_data: [
    'settings.advanced.debug_mode',
    'settings.advanced.sender_favicons',
    'settings.advanced.refresh_cache',
    'settings.advanced.export_settings',
    'settings.advanced.import_settings',
    'settings.advanced.reset_settings',
    'settings.offline.title',
    'settings.offline.enabled',
    'settings.offline.window',
    'settings.offline.max_size',
  ],
  // The theme cards are added by the caller (built-in theme names).
  themes: [],
  plugins: [],
  updates: [
    'updates.current_version',
    'updates.latest_version',
    'updates.last_checked',
    'updates.check_now',
    'updates.auto_check',
    'updates.advisory',
    'updates.release_page',
  ],
  debug: [],
};

// Extra English keywords per pane so common search terms hit even when the
// translation doesn't contain the literal word.
export const SETTINGS_SEARCH_KEYWORDS: Record<SettingsTabId, string> = {
  account: 'profile email password user signin signout reorder switch default multi-account shared storage quota',
  language: 'locale region date time format translation',
  notifications: 'alert push badge unifiedpush relay device reminder',
  appearance: 'theme dark light font size text color animation density',
  layout: 'swipe gesture quick actions toolbar order sort unified folder count avatar',
  reading: 'mark read preview thread conversation archive delete attachment open monospace mono font plain text receipt',
  composing: 'editor signature plain text reply forward draft compose autosave undo send delay',
  identities: 'from address signature email',
  vacation: 'auto reply away out of office holiday responder',
  filters: 'sieve rules block junk forward',
  templates: 'snippet quick reply',
  folders: 'mailbox rename role',
  keywords: 'tags labels colors',
  downloads: 'download filename template eml attachment save export',
  security: 'password 2fa two-factor totp app password mfa api key certificate encryption',
  encryption: 's/mime smime certificate sign encrypt',
  content_senders: 'block sender remote images privacy tracking',
  calendar: 'event schedule appointment meeting timezone',
  contacts: 'address book contact',
  files: 'attachments cloud drive storage upload',
  sidebar_apps: 'apps webview iframe',
  about_data: 'export import backup offline cache debug logs reset version',
  themes: 'theme color colour palette skin appearance',
  plugins: 'extensions addons',
  updates: 'update upgrade version apk install release',
  debug: 'logs developer console diagnostic',
};

export interface SubResult {
  label: string;
  description?: string;
}

// A sub-result as translation keys, before t().
export interface SubResultKeys {
  label: string;
  description?: string;
}

type Dictionary = Record<string, unknown>;

// Label/description fields of a setting object, most specific first: the RN
// panes render the `*_mobile` variants where the catalog has them.
const LABEL_FIELDS = ['label_mobile', 'label', 'title'];
const DESCRIPTION_FIELDS = ['description_mobile', 'description'];
// Flat `foo` + `foo_desc` style pairs (calendar.settings, files, settings.layout).
const DESCRIPTION_SUFFIXES = ['_mobile_desc', '_description_mobile', '_desc', '_description'];

export function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur && typeof cur === 'object' && key in (cur as Dictionary)) {
      cur = (cur as Dictionary)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

// Every string leaf key below `path`.
export function collectStringKeys(node: unknown, path: string, sink: string[]): void {
  if (typeof node === 'string') {
    sink.push(path);
    return;
  }
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  for (const [key, value] of Object.entries(node as Dictionary)) {
    collectStringKeys(value, `${path}.${key}`, sink);
  }
}

function descriptionFor(obj: Dictionary, base: string): string | undefined {
  return DESCRIPTION_SUFFIXES.map((s) => base + s).find((k) => typeof obj[k] === 'string');
}

// Walk a translation subtree and emit sub-results (as keys) for renderable
// settings. Picks up:
//   - objects with a label or title field (the standard pattern)
//   - flat `*_label` string keys at any object level (e.g. `name_label`)
//   - flat `foo` / `foo_desc` string pairs (the calendar.settings pattern)
export function collectSubResultKeys(node: unknown, path: string, sink: SubResultKeys[]): void {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  const obj = node as Dictionary;
  const labelField = LABEL_FIELDS.find((f) => typeof obj[f] === 'string');
  if (labelField) {
    const descField = DESCRIPTION_FIELDS.find((f) => typeof obj[f] === 'string');
    sink.push({ label: `${path}.${labelField}`, description: descField && `${path}.${descField}` });
  }
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value !== 'string' || LABEL_FIELDS.includes(key) || DESCRIPTION_FIELDS.includes(key)) continue;
    if (key.endsWith('_label')) {
      const desc = descriptionFor(obj, key.slice(0, -'_label'.length));
      sink.push({ label: `${path}.${key}`, description: desc && `${path}.${desc}` });
      continue;
    }
    const desc = descriptionFor(obj, key);
    if (desc) sink.push({ label: `${path}.${key}`, description: `${path}.${desc}` });
  }
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      collectSubResultKeys(value, `${path}.${key}`, sink);
    }
  }
}

// Sub-result for a path that points straight at a label string, with the
// description it sits next to (`foo` + `foo_desc`, `foo_title` +
// `foo_description`, `title` + `description`).
function leafSubResultKeys(dict: Dictionary, path: string): SubResultKeys {
  const dot = path.lastIndexOf('.');
  const parentPath = path.slice(0, dot);
  const key = path.slice(dot + 1);
  const parent = getByPath(dict, parentPath) as Dictionary;
  const desc = LABEL_FIELDS.includes(key) || key === 'section_title'
    ? DESCRIPTION_FIELDS.find((f) => typeof parent[f] === 'string')
    : descriptionFor(parent, key.replace(/_(label|title)$/, ''));
  return { label: path, description: desc && `${parentPath}.${desc}` };
}

// The translation keys a pane is searched by: every string below its paths
// (`keys`) and the settings among them (`subResults`).
export function collectTabKeys(
  dict: Dictionary,
  tab: SettingsTabId,
): { keys: string[]; subResults: SubResultKeys[] } {
  const keys: string[] = [];
  const subResults: SubResultKeys[] = [];
  for (const path of SETTINGS_SEARCH_PATHS[tab]) {
    const node = getByPath(dict, path);
    if (typeof node === 'string') {
      const sub = leafSubResultKeys(dict, path);
      subResults.push(sub);
      keys.push(path);
      if (sub.description) keys.push(sub.description);
    } else {
      collectStringKeys(node, path, keys);
      collectSubResultKeys(node, path, subResults);
    }
  }
  return { keys, subResults };
}

export interface SettingsSearchIndex {
  haystacks: Partial<Record<SettingsTabId, string>>;
  subResults: Partial<Record<SettingsTabId, SubResult[]>>;
}

/**
 * Build the per-pane haystack and sub-result list.
 * `dict` is the English catalog, which gives the key structure; `t` resolves
 * each key in the current locale. `extra` adds dynamic sub-results (e.g. the
 * built-in theme names).
 */
export function buildSettingsSearchIndex(
  dict: Dictionary,
  t: (key: string) => string,
  extra: Partial<Record<SettingsTabId, SubResult[]>> = {},
): SettingsSearchIndex {
  const haystacks: SettingsSearchIndex['haystacks'] = {};
  const subResults: SettingsSearchIndex['subResults'] = {};
  for (const tab of Object.keys(SETTINGS_SEARCH_PATHS) as SettingsTabId[]) {
    const { keys, subResults: subKeys } = collectTabKeys(dict, tab);
    const list: SubResult[] = [
      ...subKeys.map((k) => ({ label: t(k.label), description: k.description ? t(k.description) : undefined })),
      ...(extra[tab] ?? []),
    ];
    const seen = new Set<string>();
    subResults[tab] = list.filter((r) => {
      if (!r.label || seen.has(r.label)) return false;
      seen.add(r.label);
      return true;
    });
    const strings = [
      tab.replace(/_/g, ' '),
      SETTINGS_SEARCH_KEYWORDS[tab],
      ...keys.map(t),
      ...(extra[tab] ?? []).flatMap((r) => [r.label, r.description ?? '']),
    ];
    haystacks[tab] = strings.join(' ').toLowerCase();
  }
  return { haystacks, subResults };
}

export function normalizeSettingsQuery(query: string): string {
  return query.trim().toLowerCase();
}

// Whether a pane matches a normalized query: its (translated) name or
// anything it renders.
export function tabMatchesQuery(
  index: SettingsSearchIndex,
  tab: SettingsTabId,
  tabLabel: string,
  query: string,
): boolean {
  if (!query) return true;
  if (tabLabel.toLowerCase().includes(query)) return true;
  return index.haystacks[tab]?.includes(query) ?? false;
}

// The pane's settings whose label or description match, for the result rows
// under the pane.
export function subResultsForQuery(
  index: SettingsSearchIndex,
  tab: SettingsTabId,
  query: string,
  limit = 6,
): SubResult[] {
  if (!query) return [];
  return (index.subResults[tab] ?? [])
    .filter((r) =>
      r.label.toLowerCase().includes(query)
      || (r.description?.toLowerCase().includes(query) ?? false))
    .slice(0, limit);
}
