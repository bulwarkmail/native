import { describe, expect, it } from 'vitest';
import {
  isFeatureEnabled,
  isLockedSetting,
  policyReleasePatch,
  policySettingsPatch,
  resolvePolicy,
  sanitizePolicy,
  settingsRulesFromPolicy,
  webmailLinksFromConfig,
  helpLinks,
  type PolicyPatchContext,
} from '../org-policy';

// Policy → effective settings, ported from the webmail's policy-scopes.ts
// (resolvePolicy) and settings-store.ts (adminPolicyPatch,
// adminPolicyReleasePatch).

const keyFor = (key: string) => (key === 'firstDayOfWeek' ? 'calendarFirstDayOfWeek' : ['density', 'theme', 'markAsReadDelay', 'fontSize', 'toastDuration', 'activeThemeId', 'enableCalendarTasks', 'debugMode', 'unifiedCrossAccount', 'enableCrossUnreadView', 'enableCrossStarredView', 'enableCrossAllView'].includes(key) ? key : null);
const opts = { keyFor, themeIds: ['builtin-nord', 'builtin-qui'] };

const builtIn = {
  density: 'regular',
  theme: 'system',
  markAsReadDelay: 0,
  calendarFirstDayOfWeek: 1,
  fontSize: 'medium',
  toastDuration: -1,
  activeThemeId: null,
  enableCalendarTasks: false,
  debugMode: false,
  unifiedCrossAccount: false,
  enableCrossUnreadView: false,
  enableCrossStarredView: false,
  enableCrossAllView: false,
};

const ctx = (explicit: string[] = []): PolicyPatchContext => ({
  builtIn,
  explicit: new Set(explicit),
  isValid: (key, value) => key === 'activeThemeId'
    ? value === null || typeof value === 'string'
    : typeof value === typeof (builtIn as Record<string, unknown>)[key],
});

const policy = (raw: Record<string, unknown>) => sanitizePolicy({ restrictions: {}, features: {}, defaults: {}, themePolicy: {}, ...raw })!;

describe('sanitizePolicy', () => {
  it('keeps known parts with the right types and drops the rest', () => {
    const p = sanitizePolicy({
      restrictions: { density: { locked: true, value: 'compact', allowedValues: ['compact'] }, __proto__: { locked: true }, bad: 5 },
      features: { calendarEnabled: false, filesEnabled: 'no' },
      defaults: { density: 'compact', list: [1], n: Infinity },
      themePolicy: { defaultColorMode: 'purple', lockColorMode: true, disabledBuiltinThemes: ['builtin-nord', 3] },
      forceEnabledThemes: ['x', 1],
    })!;
    expect(p.restrictions).toEqual({ density: { locked: true, value: 'compact', allowedValues: ['compact'] } });
    expect(p.features).toEqual({ calendarEnabled: false });
    expect(p.defaults).toEqual({ density: 'compact' });
    expect(p.themePolicy).toMatchObject({ defaultColorMode: null, lockColorMode: true, disabledBuiltinThemes: ['builtin-nord'] });
    expect(p.forceEnabledThemes).toEqual(['x']);
    expect(sanitizePolicy('nope')).toBeNull();
    expect(sanitizePolicy([])).toBeNull();
  });
});

describe('resolvePolicy', () => {
  const raw = policy({
    defaults: { density: 'regular' },
    features: { calendarEnabled: true },
    scopes: [
      { id: 'sales', match: { groups: ['Sales@example.com'] }, policy: { defaults: { density: 'compact' } } },
      { id: 'eu', match: { domains: ['*.example.com'] }, policy: { features: { calendarEnabled: false }, defaults: { density: 'comfortable' } } },
      { id: 'other', match: { domains: ['other.org'] }, policy: { features: { filesEnabled: false } } },
    ],
  });

  it('applies domain scopes, then group scopes, later winning', () => {
    const effective = resolvePolicy(raw, { email: 'ada@eu.example.com', groups: ['sales@example.com'] });
    expect(effective.defaults.density).toBe('compact');
    expect(effective.features.calendarEnabled).toBe(false);
    expect(effective.features.filesEnabled).toBeUndefined();
    expect(effective.scopes).toEqual([]);
  });

  it('applies only the global policy without a matching scope or subject', () => {
    expect(resolvePolicy(raw, { email: 'bob@example.net', groups: [] }).defaults.density).toBe('regular');
    expect(resolvePolicy(raw, null).features.calendarEnabled).toBe(true);
    // *.example.com covers subdomains, not the domain itself.
    expect(resolvePolicy(raw, { email: 'ada@example.com', groups: [] }).features.calendarEnabled).toBe(true);
  });
});

describe('isFeatureEnabled', () => {
  it('reads the gate, falls back to the webmail default, and allows everything without a policy', () => {
    expect(isFeatureEnabled(null, 'calendarEnabled')).toBe(true);
    expect(isFeatureEnabled(null, 'unifiedCrossAccountEnabled')).toBe(true);
    expect(isFeatureEnabled(policy({ features: { calendarEnabled: false } }), 'calendarEnabled')).toBe(false);
    expect(isFeatureEnabled(policy({}), 'contactsEnabled')).toBe(true);
    expect(isFeatureEnabled(policy({}), 'crossUnreadViewEnabled')).toBe(false);
    expect(isFeatureEnabled(policy({ features: { allMailViewEnabled: true } }), 'crossAllViewEnabled')).toBe(true);
  });
});

describe('settingsRulesFromPolicy', () => {
  it('maps webmail keys to the app, locks to their value or default, and skips keys the app lacks', () => {
    const rules = settingsRulesFromPolicy(policy({
      defaults: { firstDayOfWeek: 0, density: 'compact', webmailOnly: true },
      restrictions: { density: { locked: true }, markAsReadDelay: { locked: true, value: 3000 }, webmailOnly: { locked: true, value: 1 }, fontSize: { hidden: true } },
    }), opts);
    expect(rules.defaults).toEqual({ calendarFirstDayOfWeek: 0, density: 'compact' });
    expect(rules.locks).toMatchObject({ density: 'compact', markAsReadDelay: 3000 });
    expect(rules.locks).not.toHaveProperty('webmailOnly');
    expect(rules.hidden).toEqual(['fontSize']);
  });

  it('pins the settings of gates that are off', () => {
    const rules = settingsRulesFromPolicy(policy({ features: { calendarTasksEnabled: false, debugModeEnabled: false, crossUnreadViewEnabled: true } }), opts);
    expect(rules.locks).toMatchObject({ enableCalendarTasks: false, debugMode: false, unifiedCrossAccount: false, enableCrossStarredView: false, enableCrossAllView: false });
    expect(rules.locks).not.toHaveProperty('enableCrossUnreadView');
  });

  it('turns the theme policy into a color-mode default or lock and theme rules', () => {
    expect(settingsRulesFromPolicy(policy({ themePolicy: { defaultColorMode: 'dark' } }), opts).defaults.theme).toBe('dark');
    expect(settingsRulesFromPolicy(policy({ themePolicy: { lockColorMode: true } }), opts).locks.theme).toBe('system');
    const themed = settingsRulesFromPolicy(policy({ themePolicy: { defaultThemeId: 'builtin-qui', disabledBuiltinThemes: ['builtin-nord', 'builtin-unknown'] } }), opts);
    expect(themed.defaults.activeThemeId).toBe('builtin-qui');
    expect(themed.blocked.activeThemeId).toEqual(['builtin-nord']);
    expect(settingsRulesFromPolicy(policy({ forceEnabledThemes: ['webmail-zip', 'builtin-nord'] }), opts).locks.activeThemeId).toBe('builtin-nord');
    expect(settingsRulesFromPolicy(policy({ features: { themesEnabled: false } }), opts).locks.activeThemeId).toBeNull();
  });

  it('is empty without a policy', () => {
    expect(settingsRulesFromPolicy(null, opts)).toEqual({ defaults: {}, locks: {}, restrictions: {}, blocked: {}, hidden: [] });
  });
});

describe('policySettingsPatch', () => {
  const state = { ...builtIn };

  it('fills defaults only into settings the user has not chosen', () => {
    const rules = settingsRulesFromPolicy(policy({ defaults: { density: 'compact', markAsReadDelay: 2000 } }), opts);
    expect(policySettingsPatch(state, rules, ctx())).toEqual({ density: 'compact', markAsReadDelay: 2000 });
    expect(policySettingsPatch(state, rules, ctx(['density']))).toEqual({ markAsReadDelay: 2000 });
  });

  it('pins a locked value whatever the user chose', () => {
    const rules = settingsRulesFromPolicy(policy({ restrictions: { density: { locked: true, value: 'compact' } } }), opts);
    expect(policySettingsPatch({ ...state, density: 'comfortable' }, rules, ctx(['density']))).toEqual({ density: 'compact' });
    expect(isLockedSetting(rules, 'density')).toBe(true);
  });

  it('treats a lock on a reading aid as a default the user may change', () => {
    const rules = settingsRulesFromPolicy(policy({ restrictions: { fontSize: { locked: true, value: 'large' } } }), opts);
    expect(policySettingsPatch(state, rules, ctx())).toEqual({ fontSize: 'large' });
    expect(policySettingsPatch({ ...state, fontSize: 'small' }, rules, ctx(['fontSize']))).toEqual({});
    expect(isLockedSetting(rules, 'fontSize')).toBe(false);
  });

  it('ignores values of the wrong type or outside the allowed values and bounds', () => {
    const rules = settingsRulesFromPolicy(policy({
      defaults: { density: 5, markAsReadDelay: 99999 },
      restrictions: { markAsReadDelay: { max: 5000 }, theme: { allowedValues: ['light'] } },
      themePolicy: { defaultColorMode: 'dark' },
    }), opts);
    expect(policySettingsPatch(state, rules, ctx())).toEqual({});
  });

  it('keeps toasts that stay until closed within a minimum', () => {
    const rules = settingsRulesFromPolicy(policy({ defaults: { toastDuration: 0 }, restrictions: { toastDuration: { min: 10 } } }), opts);
    expect(policySettingsPatch(state, rules, ctx())).toEqual({ toastDuration: 0 });
  });

  it('moves off a disabled theme', () => {
    const rules = settingsRulesFromPolicy(policy({ themePolicy: { disabledBuiltinThemes: ['builtin-nord'] } }), opts);
    expect(policySettingsPatch({ ...state, activeThemeId: 'builtin-nord' }, rules, ctx(['activeThemeId']))).toEqual({ activeThemeId: null });
  });
});

describe('policyReleasePatch', () => {
  it('puts back the default for what a policy no longer imposes, unless the user chose it', () => {
    const before = settingsRulesFromPolicy(policy({ defaults: { density: 'compact' }, restrictions: { markAsReadDelay: { locked: true, value: 3000 } } }), opts);
    const after = settingsRulesFromPolicy(policy({}), opts);
    const state = { ...builtIn, density: 'compact', markAsReadDelay: 3000 };
    expect(policyReleasePatch(state, before, after, ctx())).toEqual({ density: 'regular', markAsReadDelay: 0 });
    expect(policyReleasePatch(state, before, after, ctx(['density']))).toEqual({ markAsReadDelay: 0 });
    // A value the user changed since stays.
    expect(policyReleasePatch({ ...state, density: 'comfortable' }, before, after, ctx())).toEqual({ markAsReadDelay: 0 });
  });
});

describe('webmailLinksFromConfig and helpLinks', () => {
  it('keeps http(s) and mailto links, drops the rest, and lists them in the webmail order', () => {
    const links = webmailLinksFromConfig({
      helpUrl: 'https://help.example.org/mail',
      accessibilityStatementUrl: 'javascript:alert(1)',
      accessibilityFeedbackUrl: 'mailto:a11y@example.org',
      signLanguageUrl: 'https://dgs.example.org',
      easyReadUrl: '',
    });
    expect(links).toEqual({
      helpUrl: 'https://help.example.org/mail',
      accessibilityFeedbackUrl: 'mailto:a11y@example.org',
      signLanguageUrl: 'https://dgs.example.org',
    });
    expect(helpLinks(links).map((l) => l.id)).toEqual(['feedback', 'help', 'sign_language']);
    expect(webmailLinksFromConfig(null)).toEqual({});
    expect(helpLinks({})).toEqual([]);
  });
});
