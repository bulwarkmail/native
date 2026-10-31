import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createPersistStorage } from './persist-storage';
import { useAccountStore, type AccountEntry } from './account-store';
import { useAuthStore } from './auth-store';
import {
  SETTINGS_KEY_MAP,
  isPolicySettingKey,
  setPolicyLockedWriteListener,
  useSettingsStore,
} from './settings-store';
import { useToastStore } from './toast-store';
import { useLocaleStore } from './locale-store';
import { jmapClient } from '../api/jmap-client';
import { fetchWithoutForeignRedirect } from '../lib/client-cert';
import { isLoopbackHttp } from '../lib/oauth';
import {
  EMPTY_SETTINGS_RULES,
  isFeatureEnabled,
  isLockedSetting,
  resolvePolicy,
  sanitizePolicy,
  settingsRulesFromPolicy,
  webmailLinksFromConfig,
  type FeatureGate,
  type OrgPolicy,
  type PolicySubject,
  type SettingsRules,
  type WebmailLinks,
} from '../lib/org-policy';
import { BUILTIN_THEMES } from '../theme/builtin-themes';

// The organisation policy of the webmail each account signed in through
// (webmail stores/policy-store.ts, read with the account's access token:
// bulwarkmail.org/docs/development/mobile-handoff). The last answer is kept
// per account, so a start without network still applies it. Accounts
// signed in to a mail server directly have no webmail and no policy.

export const POLICY_FETCH_TIMEOUT_MS = 10_000;
/** Header the webmail sets on the public subset (lib/admin/types.ts). */
const POLICY_SCOPE_HEADER = 'x-bulwark-policy-scope';

export interface CachedPolicy {
  /** The policy as fetched, scopes included. */
  policy: OrgPolicy;
  /** The webmail answered with the public subset (no token, or a refused one). */
  partial: boolean;
  fetchedAt: number;
  /** The webmail it came from; an account that moved to another drops it. */
  webmailUrl: string;
  links: WebmailLinks;
}

interface PolicyState {
  byAccount: Record<string, CachedPolicy>;
  /** The account `effective` was resolved for. */
  accountId: string | null;
  /** The active account's policy with its scopes applied; null without a webmail. */
  effective: OrgPolicy | null;
  /** What `effective` does to the settings. */
  rules: SettingsRules;
  links: WebmailLinks;

  /** Resolve and apply the cached policy of this account (the active one). */
  activate: (accountId: string | null) => void;
  /** Fetch the account's policy from its webmail, cache it, and apply it when it is the active one. */
  refresh: (accountId: string) => Promise<void>;
  /** Drop the cached policies of accounts no longer in the registry. */
  prune: (accountIds: readonly string[]) => void;
}

const reverseKeyMap = new Map<string, string>(
  Object.entries(SETTINGS_KEY_MAP).map(([local, web]) => [web as string, local]),
);

/** The app's setting key for a webmail setting key, or null when the app doesn't have it. */
export function settingKeyFor(webmailKey: string): string | null {
  const mapped = reverseKeyMap.get(webmailKey);
  if (mapped) return mapped;
  // An app key the webmail names differently isn't the webmail's key.
  if (Object.prototype.hasOwnProperty.call(SETTINGS_KEY_MAP, webmailKey)) return null;
  return isPolicySettingKey(webmailKey) ? webmailKey : null;
}

const THEME_IDS = BUILTIN_THEMES.map((theme) => theme.id);

/** The settings rules of an effective policy, by the app's keys. */
export function rulesFor(policy: OrgPolicy | null): SettingsRules {
  return policy ? settingsRulesFromPolicy(policy, { keyFor: settingKeyFor, themeIds: THEME_IDS }) : EMPTY_SETTINGS_RULES;
}

function sameClientAccount(account: AccountEntry): boolean {
  return jmapClient.serverUrl === account.serverUrl && jmapClient.username === account.username;
}

/**
 * Who the policy is for (webmail lib/admin/policy-subject.ts): the
 * account's address, and the group accounts its session shows (shared,
 * not personal, named by an address).
 */
export function policySubjectFor(account: AccountEntry): PolicySubject {
  const email = (account.email || account.username).trim().toLowerCase();
  const session = sameClientAccount(account) ? jmapClient.currentSession : null;
  const groups = session
    ? Object.values(session.accounts)
      .filter((info) => !info.isPersonal && info.name.includes('@'))
      .map((info) => info.name.trim().toLowerCase())
      .sort()
    : [];
  return { email, groups };
}

function isSecureUrl(url: string): boolean {
  return /^https:\/\//i.test(url) || isLoopbackHttp(url);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * GET <webmail>/api/admin/policy. With an access token for the account,
 * the full policy for its domains; the token goes only over TLS, and names
 * the account's server so the webmail checks it there and nowhere else.
 * Without one (password accounts), the public part. Null when unreachable.
 */
export async function fetchOrgPolicy(
  webmailUrl: string,
  auth: { authorization: string; serverUrl: string } | null,
): Promise<{ policy: OrgPolicy; partial: boolean } | null> {
  const base = webmailUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (auth && /^Bearer\s/i.test(auth.authorization) && isSecureUrl(base)) {
    headers.Authorization = auth.authorization;
    headers['X-JMAP-Server-Url'] = auth.serverUrl;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POLICY_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchWithoutForeignRedirect(`${base}/api/admin/policy`, {
      headers,
      signal: controller.signal,
      timeoutMs: POLICY_FETCH_TIMEOUT_MS,
    });
    if (!response.ok) return null;
    const policy = sanitizePolicy(await readJson(response));
    if (!policy) return null;
    const partial = response.headers?.get?.(POLICY_SCOPE_HEADER) === 'public';
    return { policy, partial };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The operator's links from <webmail>/api/config; null when unreachable. */
export async function fetchWebmailLinks(webmailUrl: string): Promise<WebmailLinks | null> {
  const base = webmailUrl.replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POLICY_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchWithoutForeignRedirect(`${base}/api/config`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      timeoutMs: POLICY_FETCH_TIMEOUT_MS,
    });
    if (!response.ok) return null;
    return webmailLinksFromConfig(await readJson(response));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The account's Authorization header when the live client serves it with a token. */
async function bearerFor(account: AccountEntry): Promise<{ authorization: string; serverUrl: string } | null> {
  if (!sameClientAccount(account) || !jmapClient.usesBearerAuth) return null;
  try {
    await jmapClient.ensureFreshToken();
    return { authorization: jmapClient.authHeader, serverUrl: account.serverUrl };
  } catch {
    return null;
  }
}

const refreshes = new Map<string, Promise<void>>();

export const usePolicyStore = create<PolicyState>()(
  persist(
    (set, get) => ({
      byAccount: {},
      accountId: null,
      effective: null,
      rules: EMPTY_SETTINGS_RULES,
      links: {},

      activate: (accountId) => {
        const account = accountId ? useAccountStore.getState().getAccountById(accountId) : undefined;
        const cached = accountId ? get().byAccount[accountId] : undefined;
        // Only a policy from the webmail the account signed in through.
        const usable = account?.webmailUrl && cached && cached.webmailUrl === account.webmailUrl ? cached : null;
        const effective = usable && account ? resolvePolicy(usable.policy, policySubjectFor(account)) : null;
        const rules = rulesFor(effective);
        set({ accountId: accountId ?? null, effective, rules, links: usable?.links ?? {} });
        useSettingsStore.getState().applyPolicyRules(rules);
      },

      refresh: (accountId) => {
        const running = refreshes.get(accountId);
        if (running) return running;
        const run = (async () => {
          const account = useAccountStore.getState().getAccountById(accountId);
          const webmailUrl = account?.webmailUrl;
          if (!account || !webmailUrl) return;
          const auth = await bearerFor(account);
          const [fetched, links] = await Promise.all([fetchOrgPolicy(webmailUrl, auth), fetchWebmailLinks(webmailUrl)]);
          if (!fetched) return; // offline or no policy route: keep what is cached
          // Signed out of the account meanwhile.
          if (!useAccountStore.getState().getAccountById(accountId)) return;
          const previous = get().byAccount[accountId];
          set({
            byAccount: {
              ...get().byAccount,
              [accountId]: {
                policy: fetched.policy,
                partial: fetched.partial,
                fetchedAt: Date.now(),
                webmailUrl,
                links: links ?? (previous?.webmailUrl === webmailUrl ? previous.links : {}),
              },
            },
          });
          if (useAuthStore.getState().activeAccountId === accountId) get().activate(accountId);
        })().finally(() => refreshes.delete(accountId));
        refreshes.set(accountId, run);
        return run;
      },

      prune: (accountIds) => {
        const keep = new Set(accountIds);
        const current = get().byAccount;
        if (Object.keys(current).every((id) => keep.has(id))) return;
        set({ byAccount: Object.fromEntries(Object.entries(current).filter(([id]) => keep.has(id))) });
      },
    }),
    {
      name: 'org-policy-cache',
      storage: createPersistStorage(),
      partialize: (state) => ({ byAccount: state.byAccount }) as unknown as PolicyState,
    },
  ),
);

/** Whether a feature gate of the active account's policy is on (everything is without a webmail). */
export function usePolicyFeature(feature: FeatureGate): boolean {
  return usePolicyStore((s) => isFeatureEnabled(s.effective, feature));
}

/** Whether the active account's policy pins a setting (by the app's key). */
export function useSettingLocked(key: string): boolean {
  return usePolicyStore((s) => isLockedSetting(s.rules, key));
}

/**
 * Whether the active account's webmail runs without third-party traffic
 * (webmail hooks/use-third-party-mode.ts): remote content in mail never
 * loads, whatever the setting or a trusted sender says.
 */
export function useNoThirdPartyTraffic(): boolean {
  return usePolicyStore((s) => s.links.noThirdPartyTraffic === true);
}

/** Whether the active account's policy hides a setting (by the app's key). */
export function useSettingHidden(key: string): boolean {
  return usePolicyStore((s) => s.rules.hidden.includes(key));
}

let syncStarted = false;

/**
 * Keep the policy following the active account: the cached one applies at
 * once (also offline), and it is fetched again on start and on every
 * account switch, once the account's session is up (its token is needed).
 * Returns the unsubscribe.
 */
export function startPolicySync(): () => void {
  if (syncStarted) return () => undefined;
  syncStarted = true;

  const t = () => useLocaleStore.getState().t;
  setPolicyLockedWriteListener(() => {
    useToastStore.getState().addToast({
      type: 'info',
      title: t()('settings.org_locked', 'Set by your organisation'),
    });
  });

  let activeId: string | null = null;
  let fetchedFor: string | null = null;
  const follow = () => {
    const auth = useAuthStore.getState();
    const id = auth.activeAccountId ?? useAccountStore.getState().activeAccountId;
    if (id !== activeId) {
      activeId = id;
      fetchedFor = null;
      usePolicyStore.getState().activate(id);
    }
    if (id && auth.session && fetchedFor !== id) {
      fetchedFor = id;
      void usePolicyStore.getState().refresh(id);
    }
  };

  const whenHydrated = (fn: () => void) => {
    if (usePolicyStore.persist.hasHydrated()) fn();
    else usePolicyStore.persist.onFinishHydration(fn);
  };
  whenHydrated(follow);

  const offAuth = useAuthStore.subscribe((state, prev) => {
    if (state.activeAccountId === prev.activeAccountId && state.session === prev.session) return;
    whenHydrated(follow);
  });
  const offAccounts = useAccountStore.subscribe((state, prev) => {
    if (state.accounts === prev.accounts) return;
    usePolicyStore.getState().prune(state.accounts.map((a) => a.id));
    // A sign-in through a webmail stores its address after the account
    // became active: fetch now that it is known.
    const id = activeId;
    const now = id ? state.accounts.find((a) => a.id === id) : undefined;
    const before = id ? prev.accounts.find((a) => a.id === id) : undefined;
    if (id && now?.webmailUrl && now.webmailUrl !== before?.webmailUrl) {
      fetchedFor = null;
      whenHydrated(follow);
    }
  });

  return () => {
    offAuth();
    offAccounts();
    setPolicyLockedWriteListener(null);
    syncStarted = false;
  };
}
