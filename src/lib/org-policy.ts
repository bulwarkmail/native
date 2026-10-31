/**
 * The organisation policy of a Bulwark webmail (GET <webmail>/api/admin/policy,
 * bulwarkmail.org/docs/development/mobile-handoff), and what it means for
 * the app's settings. Pure functions: the policy store fetches and caches,
 * the settings store applies what policySettingsPatch returns.
 *
 * Ported from the webmail:
 *  - lib/admin/types.ts (SettingsPolicy, FeatureGates, ThemePolicy)
 *  - lib/admin/policy-scopes.ts (resolvePolicy: domain and group scopes)
 *  - stores/settings-store.ts (adminPolicyPatch, adminPolicyReleasePatch):
 *    `defaults` fill settings the user hasn't chosen, a locked restriction
 *    pins its value whatever the user chose, and a value a policy stops
 *    imposing goes back to the build default
 *  - stores/policy-store.ts getColorModePolicy and stores/theme-store.ts:
 *    the theme policy's color mode and themes
 *
 * policy.json is written by hand, so everything read here is checked.
 */

export interface SettingRestriction {
  locked?: boolean;
  value?: unknown;
  hidden?: boolean;
  allowedValues?: unknown[];
  min?: number;
  max?: number;
}

export type ColorMode = 'light' | 'dark' | 'system';

export interface ThemePolicy {
  disabledBuiltinThemes: string[];
  disabledThemes: string[];
  defaultThemeId: string | null;
  defaultColorMode: ColorMode | null;
  lockColorMode: boolean;
}

export interface PolicyScope {
  id: string;
  match: { domains?: string[]; groups?: string[] };
  policy: {
    features?: Record<string, boolean>;
    restrictions?: Record<string, SettingRestriction>;
    defaults?: Record<string, unknown>;
    organisation?: Record<string, unknown>;
  };
}

/** The parts of the webmail's SettingsPolicy the app uses. */
export interface OrgPolicy {
  restrictions: Record<string, SettingRestriction>;
  features: Record<string, boolean>;
  defaults: Record<string, unknown>;
  themePolicy: ThemePolicy;
  forceEnabledThemes: string[];
  /** Organisation settings (signatures, disclaimer...), kept as sent. */
  organisation?: Record<string, unknown>;
  /** Domain and group overrides; empty once resolved for an account. */
  scopes: PolicyScope[];
}

/** Who the policy is resolved for: the account's address and its group accounts. */
export interface PolicySubject {
  email: string;
  groups: string[];
}

/**
 * The webmail's built-in gate values (lib/admin/types.ts
 * DEFAULT_FEATURE_GATES) for the gates the app reads. A policy without a
 * gate gets this.
 */
export const DEFAULT_FEATURE_GATES = {
  themesEnabled: true,
  templatesEnabled: true,
  customKeywordsEnabled: true,
  calendarEnabled: true,
  calendarTasksEnabled: true,
  smimeEnabled: true,
  externalContentEnabled: true,
  debugModeEnabled: true,
  filesEnabled: true,
  contactsEnabled: true,
  settingsExportEnabled: true,
  sidebarAppsEnabled: true,
  crossUnreadViewEnabled: false,
  crossStarredViewEnabled: false,
  crossAllViewEnabled: false,
  unifiedCrossAccountEnabled: false,
  customFromEnabled: true,
  archiveActionEnabled: true,
  structuredMailEnabled: true,
} as const;

export type FeatureGate = keyof typeof DEFAULT_FEATURE_GATES;

const DEFAULT_THEME_POLICY: ThemePolicy = {
  disabledBuiltinThemes: [],
  disabledThemes: [],
  defaultThemeId: null,
  defaultColorMode: null,
  lockColorMode: false,
};

const COLOR_MODES: readonly ColorMode[] = ['light', 'dark', 'system'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const isSafeKey = (key: string) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype';

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function sanitizeRestriction(raw: unknown): SettingRestriction | null {
  if (!isRecord(raw)) return null;
  const out: SettingRestriction = {};
  if (typeof raw.locked === 'boolean') out.locked = raw.locked;
  if (typeof raw.hidden === 'boolean') out.hidden = raw.hidden;
  if ('value' in raw) out.value = raw.value;
  if (Array.isArray(raw.allowedValues)) out.allowedValues = raw.allowedValues.slice(0, 100);
  if (typeof raw.min === 'number' && Number.isFinite(raw.min)) out.min = raw.min;
  if (typeof raw.max === 'number' && Number.isFinite(raw.max)) out.max = raw.max;
  return out;
}

function sanitizeRestrictions(raw: unknown): Record<string, SettingRestriction> {
  const out: Record<string, SettingRestriction> = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!isSafeKey(key)) continue;
    const restriction = sanitizeRestriction(value);
    if (restriction) out[key] = restriction;
  }
  return out;
}

function sanitizeFeatures(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (isSafeKey(key) && typeof value === 'boolean') out[key] = value;
  }
  return out;
}

function sanitizeDefaults(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!isSafeKey(key)) continue;
    if (typeof value === 'boolean' || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) {
      out[key] = value;
    }
  }
  return out;
}

function sanitizeThemePolicy(raw: unknown): ThemePolicy {
  if (!isRecord(raw)) return { ...DEFAULT_THEME_POLICY };
  return {
    disabledBuiltinThemes: stringList(raw.disabledBuiltinThemes),
    disabledThemes: stringList(raw.disabledThemes),
    defaultThemeId: typeof raw.defaultThemeId === 'string' && raw.defaultThemeId ? raw.defaultThemeId : null,
    defaultColorMode: COLOR_MODES.find((m) => m === raw.defaultColorMode) ?? null,
    lockColorMode: raw.lockColorMode === true,
  };
}

const lowerList = (value: unknown) => stringList(value).map((v) => v.trim().toLowerCase().replace(/\.+$/, '')).filter(Boolean);

function sanitizeScopes(raw: unknown): PolicyScope[] {
  if (!Array.isArray(raw)) return [];
  const out: PolicyScope[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== 'string' || seen.has(item.id)) continue;
    seen.add(item.id);
    const match = isRecord(item.match) ? item.match : {};
    const policy = isRecord(item.policy) ? item.policy : {};
    out.push({
      id: item.id,
      match: { domains: lowerList(match.domains), groups: lowerList(match.groups) },
      policy: {
        features: sanitizeFeatures(policy.features),
        restrictions: sanitizeRestrictions(policy.restrictions),
        defaults: sanitizeDefaults(policy.defaults),
        ...(isRecord(policy.organisation) ? { organisation: policy.organisation } : {}),
      },
    });
    if (out.length >= 200) break;
  }
  return out;
}

/** The policy from the webmail's JSON, or null when it isn't one. */
export function sanitizePolicy(raw: unknown): OrgPolicy | null {
  if (!isRecord(raw)) return null;
  return {
    restrictions: sanitizeRestrictions(raw.restrictions),
    features: sanitizeFeatures(raw.features),
    defaults: sanitizeDefaults(raw.defaults),
    themePolicy: sanitizeThemePolicy(raw.themePolicy),
    forceEnabledThemes: stringList(raw.forceEnabledThemes),
    ...(isRecord(raw.organisation) ? { organisation: raw.organisation } : {}),
    scopes: sanitizeScopes(raw.scopes),
  };
}

function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase().replace(/\.+$/, '') : '';
}

function domainPatternMatches(pattern: string, domain: string): boolean {
  if (!domain) return false;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1);
    return domain.endsWith(suffix) && domain.length > suffix.length;
  }
  return pattern === domain;
}

/**
 * The effective policy for `subject` (webmail resolvePolicy): the global
 * policy with each matching scope applied on top, domain matches first,
 * then group matches, the later value winning per key. Organisation
 * settings merge per section. No subject: only the global policy.
 */
export function resolvePolicy(policy: OrgPolicy, subject: PolicySubject | null): OrgPolicy {
  let features = { ...policy.features };
  let restrictions = { ...policy.restrictions };
  let defaults = { ...policy.defaults };
  let organisation = policy.organisation;
  if (subject) {
    const domain = domainOf(subject.email);
    const groups = new Set(subject.groups.map((g) => g.trim().toLowerCase()));
    const byDomain = policy.scopes.filter((s) => (s.match.domains ?? []).some((p) => domainPatternMatches(p, domain)));
    const byGroup = policy.scopes.filter((s) => !byDomain.includes(s) && (s.match.groups ?? []).some((g) => groups.has(g)));
    for (const scope of [...byDomain, ...byGroup]) {
      features = { ...features, ...(scope.policy.features ?? {}) };
      restrictions = { ...restrictions, ...(scope.policy.restrictions ?? {}) };
      defaults = { ...defaults, ...(scope.policy.defaults ?? {}) };
      if (scope.policy.organisation) {
        const merged: Record<string, unknown> = { ...(organisation ?? {}) };
        for (const [section, values] of Object.entries(scope.policy.organisation)) {
          merged[section] = isRecord(values) && isRecord(merged[section])
            ? { ...(merged[section] as Record<string, unknown>), ...values }
            : values;
        }
        organisation = merged;
      }
    }
  }
  return { ...policy, features, restrictions, defaults, ...(organisation ? { organisation } : {}), scopes: [] };
}

/** Whether a gate is on; without a policy (no webmail known) everything is. */
export function isFeatureEnabled(policy: OrgPolicy | null | undefined, feature: FeatureGate): boolean {
  if (!policy) return true;
  const value = policy.features[feature];
  if (feature === 'crossAllViewEnabled' && value === undefined && typeof policy.features.allMailViewEnabled === 'boolean') {
    // Folded into crossAllViewEnabled (webmail normalizes it forward).
    return policy.features.allMailViewEnabled;
  }
  return typeof value === 'boolean' ? value : DEFAULT_FEATURE_GATES[feature];
}

/**
 * What a policy does to the app's settings, by the app's setting keys.
 *  - defaults: values for settings the user hasn't chosen
 *  - locks: values pinned whatever the user chose
 *  - restrictions: allowed values and bounds a value must keep to
 *  - blocked: values a setting may not hold (a disabled theme)
 *  - hidden: settings not offered
 */
export interface SettingsRules {
  defaults: Record<string, unknown>;
  locks: Record<string, unknown>;
  restrictions: Record<string, SettingRestriction>;
  blocked: Record<string, unknown[]>;
  hidden: string[];
}

export const EMPTY_SETTINGS_RULES: SettingsRules = { defaults: {}, locks: {}, restrictions: {}, blocked: {}, hidden: [] };

/**
 * Gates that turn an app setting off: the webmail hides the option and the
 * view it opts into, so the setting is pinned off here.
 */
const GATED_SETTINGS: ReadonlyArray<[FeatureGate, string]> = [
  ['calendarTasksEnabled', 'enableCalendarTasks'],
  ['debugModeEnabled', 'debugMode'],
  ['unifiedCrossAccountEnabled', 'unifiedCrossAccount'],
  ['crossUnreadViewEnabled', 'enableCrossUnreadView'],
  ['crossStarredViewEnabled', 'enableCrossStarredView'],
  ['crossAllViewEnabled', 'enableCrossAllView'],
];

const hasOwn = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * The settings rules of an (effective) policy. `keyFor` maps a webmail
 * setting key to the app's (null for one the app doesn't have);
 * `themeIds` are the app's built-in theme ids.
 */
export function settingsRulesFromPolicy(
  policy: OrgPolicy | null | undefined,
  opts: { keyFor: (webmailKey: string) => string | null; themeIds: readonly string[] },
): SettingsRules {
  if (!policy) return EMPTY_SETTINGS_RULES;
  const rules: SettingsRules = { defaults: {}, locks: {}, restrictions: {}, blocked: {}, hidden: [] };

  for (const [key, value] of Object.entries(policy.defaults)) {
    const local = opts.keyFor(key);
    if (local) rules.defaults[local] = value;
  }
  for (const [key, restriction] of Object.entries(policy.restrictions)) {
    const local = opts.keyFor(key);
    if (!local) continue;
    rules.restrictions[local] = restriction;
    if (restriction.hidden === true) rules.hidden.push(local);
    if (restriction.locked !== true) continue;
    const value = hasOwn(restriction, 'value') ? restriction.value : hasOwn(policy.defaults, key) ? policy.defaults[key] : undefined;
    if (value !== undefined) rules.locks[local] = value;
  }

  for (const [gate, key] of GATED_SETTINGS) {
    if (!isFeatureEnabled(policy, gate)) rules.locks[key] = false;
  }

  // Color mode (#1280): the default for users who haven't picked one, and
  // for everyone while locked; a lock without a mode pins system.
  const tp = policy.themePolicy;
  if (tp.lockColorMode) rules.locks.theme = tp.defaultColorMode ?? 'system';
  else if (tp.defaultColorMode) rules.defaults.theme = tp.defaultColorMode;

  // Themes: forced > the user's choice > the policy default; a disabled one
  // can't be kept. With themes turned off, the built-in default.
  const known = new Set(opts.themeIds);
  const disabled = tp.disabledBuiltinThemes.filter((id) => known.has(id));
  if (disabled.length) rules.blocked.activeThemeId = disabled;
  const forced = policy.forceEnabledThemes.find((id) => known.has(id));
  if (!isFeatureEnabled(policy, 'themesEnabled')) rules.locks.activeThemeId = null;
  else if (forced) rules.locks.activeThemeId = forced;
  else if (tp.defaultThemeId && known.has(tp.defaultThemeId) && !disabled.includes(tp.defaultThemeId)) {
    rules.defaults.activeThemeId = tp.defaultThemeId;
  }
  return rules;
}

/**
 * Text size, contrast, motion and the other reading aids can't be locked
 * (webmail lib/accessibility-settings.ts UNLOCKABLE_SETTING_KEYS): a lock on
 * one of them works as a default the user may change.
 */
export const UNLOCKABLE_SETTING_KEYS: ReadonlySet<string> = new Set([
  'fontSize', 'reduceMotion', 'contrast', 'reduceTransparency', 'underlineLinks', 'showColorNames', 'colorBlindPalette',
  'appFont', 'lineSpacing', 'letterSpacing', 'wordSpacing', 'paragraphSpacing', 'readingWidth', 'readingMask',
  'plainLanguage', 'pauseAnimatedImages', 'focusRing', 'focusAlwaysVisible', 'largeTargets', 'largeCursor',
  'openOnHover', 'showRowActionButton', 'nativeScrollbars', 'mailViewMode', 'mailTextScale', 'mailMinFontSize',
  'mailOverrideStyles', 'mailFitWidth', 'readAloudRate', 'readAloudVoice', 'visualAlerts', 'unreadCountStyle',
  'doNotDisturb', 'announceNewMail', 'announceRowPreview', 'simpleMode', 'simpleModePagedList', 'showAccessibilityButton',
  'plainTextFont', 'emailAlwaysLightMode', 'showToolbarLabels',
]);

export interface PolicyPatchContext {
  /** The build defaults of the settings, by the app's keys. */
  builtIn: Record<string, unknown>;
  /** Settings the user chose themselves. */
  explicit: ReadonlySet<string>;
  /** Whether a value is one the setting can hold (type and validators). */
  isValid: (key: string, value: unknown) => boolean;
}

/** The keys a lock holds: unlockable ones only while the user hasn't chosen. */
export function lockedKeys(rules: SettingsRules, explicit: ReadonlySet<string>): string[] {
  return Object.keys(rules.locks).filter((key) => !(UNLOCKABLE_SETTING_KEYS.has(key) && explicit.has(key)));
}

/** Whether the user may not change `key`: locked, and not one of the reading aids. */
export function isLockedSetting(rules: SettingsRules, key: string): boolean {
  return hasOwn(rules.locks, key) && !UNLOCKABLE_SETTING_KEYS.has(key);
}

function allowedBy(key: string, value: unknown, rules: SettingsRules, ctx: PolicyPatchContext): boolean {
  if (!hasOwn(ctx.builtIn, key) || !ctx.isValid(key, value)) return false;
  return policyAllowsValue(key, value, rules);
}

/**
 * Whether the policy lets `key` hold `value`: not a blocked value, inside
 * the restriction's allowed values and bounds. Says nothing about locks.
 */
export function policyAllowsValue(key: string, value: unknown, rules: SettingsRules): boolean {
  if ((rules.blocked[key] ?? []).includes(value)) return false;
  const restriction = rules.restrictions[key];
  if (!restriction) return true;
  if (Array.isArray(restriction.allowedValues) && restriction.allowedValues.length > 0 && !restriction.allowedValues.includes(value)) {
    return false;
  }
  if (typeof value === 'number') {
    // toastDuration: 0 keeps toasts until closed, which meets any minimum;
    // -1 (automatic) is 5 s.
    const effective = key === 'toastDuration' ? (value === 0 ? Infinity : value === -1 ? 5 : value) : value;
    if (typeof restriction.min === 'number' && effective < restriction.min) return false;
    if (typeof restriction.max === 'number' && effective > restriction.max) return false;
  }
  return true;
}

/**
 * What the policy changes in `state` (webmail adminPolicyPatch): each
 * default for a setting the user hasn't chosen, then each lock whatever
 * they chose, and a value the policy no longer allows (a disabled theme)
 * back to the default.
 */
export function policySettingsPatch(
  state: Record<string, unknown>,
  rules: SettingsRules,
  ctx: PolicyPatchContext,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rules.defaults)) {
    if (ctx.explicit.has(key) || !allowedBy(key, value, rules, ctx)) continue;
    if (state[key] !== value) patch[key] = value;
  }
  for (const [key, blocked] of Object.entries(rules.blocked)) {
    const current = hasOwn(patch, key) ? patch[key] : state[key];
    if (!blocked.includes(current) || !hasOwn(ctx.builtIn, key)) continue;
    const fallback = hasOwn(rules.defaults, key) && allowedBy(key, rules.defaults[key], rules, ctx) ? rules.defaults[key] : ctx.builtIn[key];
    patch[key] = fallback;
  }
  for (const key of lockedKeys(rules, ctx.explicit)) {
    const value = rules.locks[key];
    if (!allowedBy(key, value, rules, ctx)) continue;
    if (state[key] !== value) patch[key] = value;
    else delete patch[key];
  }
  return patch;
}

function imposed(rules: SettingsRules): Map<string, unknown> {
  const out = new Map<string, unknown>(Object.entries(rules.defaults));
  for (const [key, value] of Object.entries(rules.locks)) out.set(key, value);
  return out;
}

/**
 * What goes back to the build default when a policy stops imposing a value
 * (webmail adminPolicyReleasePatch): another account's policy, or the admin
 * removed it. Only for settings the user hasn't chosen that still hold the
 * imposed value.
 */
export function policyReleasePatch(
  state: Record<string, unknown>,
  previous: SettingsRules,
  next: SettingsRules,
  ctx: Pick<PolicyPatchContext, 'builtIn' | 'explicit'>,
): Record<string, unknown> {
  const before = imposed(previous);
  const after = imposed(next);
  const patch: Record<string, unknown> = {};
  for (const [key, value] of before) {
    if (after.has(key) || ctx.explicit.has(key) || !hasOwn(ctx.builtIn, key)) continue;
    if (state[key] === value && value !== ctx.builtIn[key]) patch[key] = ctx.builtIn[key];
  }
  return patch;
}

/** Operator links from the webmail's /api/config (per domain there). */
export interface WebmailLinks {
  accessibilityStatementUrl?: string;
  accessibilityFeedbackUrl?: string;
  helpUrl?: string;
  easyReadUrl?: string;
  signLanguageUrl?: string;
  /** The config's company name (`loginCompanyName`), for the organisation signature's {company}. */
  companyName?: string;
  /**
   * The webmail's "no third-party traffic" mode (#903, config
   * `noThirdPartyTraffic`): remote content in mail never loads.
   */
  noThirdPartyTraffic?: boolean;
}

/** The accessibility and help links, in the webmail's fixed order (lib/help-links.ts). */
/** The keys of WebmailLinks that hold a link. */
export type WebmailLinkKey = Exclude<keyof WebmailLinks, 'companyName' | 'noThirdPartyTraffic'>;

export const HELP_LINK_ORDER: ReadonlyArray<[HelpLinkId, WebmailLinkKey]> = [
  ['statement', 'accessibilityStatementUrl'],
  ['feedback', 'accessibilityFeedbackUrl'],
  ['help', 'helpUrl'],
  ['easy_read', 'easyReadUrl'],
  ['sign_language', 'signLanguageUrl'],
];

export type HelpLinkId = 'statement' | 'feedback' | 'help' | 'easy_read' | 'sign_language';

const LINK_RE = /^(https?:\/\/|mailto:)\S+$/i;

/** The links of a /api/config answer: http(s) and mailto: only. */
export function webmailLinksFromConfig(raw: unknown): WebmailLinks {
  if (!isRecord(raw)) return {};
  const out: WebmailLinks = {};
  for (const [, key] of HELP_LINK_ORDER) {
    const value = raw[key];
    if (typeof value === 'string' && LINK_RE.test(value.trim())) out[key] = value.trim();
  }
  if (typeof raw.loginCompanyName === 'string' && raw.loginCompanyName.trim()) {
    out.companyName = raw.loginCompanyName.trim().slice(0, 200);
  }
  // A boolean, or a string as in env (webmail lib/third-party-mode.ts parseNoThirdPartyValue).
  const noThirdParty = raw.noThirdPartyTraffic;
  if (noThirdParty === true || (typeof noThirdParty === 'string' && /^(true|1|yes|on)$/i.test(noThirdParty.trim()))) {
    out.noThirdPartyTraffic = true;
  }
  return out;
}

/** The configured links in their order (webmail helpLinksFrom); empty when none are set. */
export function helpLinks(links: WebmailLinks): { id: HelpLinkId; href: string }[] {
  const out: { id: HelpLinkId; href: string }[] = [];
  for (const [id, key] of HELP_LINK_ORDER) {
    const href = links[key]?.trim() ?? '';
    if (LINK_RE.test(href)) out.push({ id, href });
  }
  return out;
}
