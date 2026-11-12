import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAccountStore } from '../stores/account-store';
import { usePolicyStore } from '../stores/policy-store';
import { t } from '../stores/locale-store';
import { useToastStore } from '../stores/toast-store';
import { organisationForAccount } from './account-organisation';
import { flushComposers } from './compose-flush-registry';
import { DEFAULT_ORGANISATION, type OrgSessionPolicy } from './org-organisation';

// The organisation's idle sign-out and maximum session length (policy
// `organisation.session`; webmail lib/session-policy/limits.ts,
// session-timer.ts, components/session/session-timeout-guard.tsx). Every
// account signed in here has its own policy; the device follows the
// strictest: the shortest idle time any of them sets, and the first maximum
// session length to run out. 0 is off.
//
// On a phone the app counts as in use while it is in the foreground (the
// phone's own screen lock sends it to the background); the idle time runs
// from the moment it left the foreground. A session that ran out while the
// app was away ends when it comes back, or at the next start.

export interface SessionLimits {
  idle: { minutes: number; warnSeconds: number } | null;
  /** `at`: when the first account's maximum session length runs out, a minute early. */
  max: { at: number; hours: number; warnSeconds: number } | null;
}

export const NO_SESSION_LIMITS: SessionLimits = { idle: null, max: null };

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
/** The device ends a maximum session length this much before the server would refuse it. */
export const MAX_SKEW_MARGIN_MS = 60 * 1000;
/** How long the sign-out waits for the open composers to save their drafts. */
export const DRAFT_FLUSH_TIMEOUT_MS = 8000;

export interface AccountSession {
  session: OrgSessionPolicy | undefined;
  signedInAt?: number;
}

export function sessionLimits(accounts: readonly AccountSession[]): SessionLimits {
  let idle: SessionLimits['idle'] = null;
  let max: SessionLimits['max'] = null;
  for (const account of accounts) {
    const session = account.session ?? DEFAULT_ORGANISATION.session;
    const warnSeconds = session.warnSeconds;
    if (session.idleMinutes > 0 && (!idle || session.idleMinutes < idle.minutes)) {
      idle = { minutes: session.idleMinutes, warnSeconds };
    }
    if (session.maxHours > 0 && typeof account.signedInAt === 'number') {
      const at = account.signedInAt + session.maxHours * HOUR_MS - MAX_SKEW_MARGIN_MS;
      if (!max || at < max.at) max = { at, hours: session.maxHours, warnSeconds };
    }
  }
  return { idle, max };
}

export type SessionEndKind = 'idle' | 'max';

export interface SessionState {
  phase: 'active' | 'warning' | 'expired';
  kind: SessionEndKind | null;
  /** When the session ends (ms); null without a limit. */
  deadline: number | null;
  /** When the warning starts; null without a limit. */
  warnFrom: number | null;
}

/** Where the session stands at `now` (webmail createSessionTimer's evaluate): the deadline that comes first. */
export function sessionState(limits: SessionLimits, lastActivity: number, now: number): SessionState {
  const idleMs = limits.idle ? limits.idle.minutes * MINUTE_MS : 0;
  const idle = limits.idle
    ? { kind: 'idle' as const, deadline: lastActivity + idleMs, warnMs: Math.min(limits.idle.warnSeconds * 1000, idleMs) }
    : null;
  const max = limits.max ? { kind: 'max' as const, deadline: limits.max.at, warnMs: limits.max.warnSeconds * 1000 } : null;
  const next = idle && max ? (max.deadline <= idle.deadline ? max : idle) : idle ?? max;
  if (!next) return { phase: 'active', kind: null, deadline: null, warnFrom: null };
  const warnFrom = next.deadline - next.warnMs;
  const phase = now >= next.deadline ? 'expired' : now >= warnFrom ? 'warning' : 'active';
  return { phase, kind: next.kind, deadline: next.deadline, warnFrom };
}

// ── What the device remembers ───────────────────────────────────────────

const SIGNED_IN_KEY = 'bulwark.session.signed-in.v1';
const LAST_ACTIVITY_KEY = 'bulwark.session.last-activity.v1';

let signedIn: Record<string, number> | null = null;
let lastActivityCache: number | null = null;
let loading: Promise<void> | null = null;

function load(): Promise<void> {
  if (signedIn) return Promise.resolve();
  loading ??= (async () => {
    let map: Record<string, number> = {};
    let last: number | null = null;
    try {
      const [rawMap, rawLast] = await Promise.all([AsyncStorage.getItem(SIGNED_IN_KEY), AsyncStorage.getItem(LAST_ACTIVITY_KEY)]);
      const parsed = rawMap ? JSON.parse(rawMap) : null;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        map = Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === 'number' && Number.isFinite(v))) as Record<string, number>;
      }
      const n = rawLast ? Number(rawLast) : NaN;
      last = Number.isFinite(n) ? n : null;
    } catch {
      // Unreadable: counted from now.
    }
    signedIn = { ...map, ...(signedIn ?? {}) };
    lastActivityCache ??= last;
  })().finally(() => { loading = null; });
  return loading;
}

function saveSignedIn(): void {
  void AsyncStorage.setItem(SIGNED_IN_KEY, JSON.stringify(signedIn ?? {})).catch(() => undefined);
}

/** A new sign-in to an account: its maximum session length counts from now. */
export function noteSignedIn(accountId: string, at: number = Date.now()): void {
  signedIn = { ...(signedIn ?? {}), [accountId]: at };
  if (!loading) saveSignedIn();
  else void loading.then(() => { signedIn = { ...(signedIn ?? {}), [accountId]: at }; saveSignedIn(); });
}

/** When the account signed in; one signed in before this was recorded counts as signed in now, the first time it is seen. */
export function signedInAtFor(accountId: string, now: number = Date.now()): number {
  const known = signedIn?.[accountId];
  if (typeof known === 'number') return known;
  signedIn = { ...(signedIn ?? {}), [accountId]: now };
  saveSignedIn();
  return now;
}

/** The app was in use at `at`. */
export function noteActivity(at: number = Date.now()): void {
  if (lastActivityCache !== null && at <= lastActivityCache) return;
  lastActivityCache = at;
  void AsyncStorage.setItem(LAST_ACTIVITY_KEY, String(at)).catch(() => undefined);
}

export function lastActivity(): number | null {
  return lastActivityCache;
}

/** Only for tests: forget what was loaded. */
export function resetSessionMemoryForTests(): void {
  signedIn = null;
  lastActivityCache = null;
  loading = null;
}

// ── The limits of the accounts signed in here ───────────────────────────

/** The limits of every account signed in (not the refused ones), each with its own scopes. */
export function currentSessionLimits(now: number = Date.now()): SessionLimits {
  const accounts = useAccountStore.getState().accounts.filter((a) => !a.needsSignIn);
  // Accounts gone from the list need no sign-in time any more.
  if (signedIn && Object.keys(signedIn).some((id) => !accounts.some((a) => a.id === id))) {
    signedIn = Object.fromEntries(Object.entries(signedIn).filter(([id]) => accounts.some((a) => a.id === id)));
    saveSignedIn();
  }
  return sessionLimits(accounts.map((account) => {
    const session = organisationForAccount(account.id).session;
    const limited = session.idleMinutes > 0 || session.maxHours > 0;
    return { session, signedInAt: limited ? signedInAtFor(account.id, now) : signedIn?.[account.id] };
  }));
}

async function policyHydrated(timeoutMs: number): Promise<void> {
  if (usePolicyStore.persist.hasHydrated()) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const off = usePolicyStore.persist.onFinishHydration(() => {
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

/** The device's memory and the policy are read (bounded wait for the policy). */
export async function loadSessionMemory(): Promise<void> {
  await Promise.all([load(), policyHydrated(1500)]);
}

/**
 * At a start: the limit that ran out while the app was closed, or null. A
 * reload after a pause longer than the idle time ends the session, as one
 * after the maximum session length does (webmail 6e5d8faec).
 */
export async function sessionEndedWhileAway(now: number = Date.now()): Promise<{ kind: SessionEndKind; limits: SessionLimits } | null> {
  await loadSessionMemory();
  const limits = currentSessionLimits(now);
  if (!limits.idle && !limits.max) return null;
  const state = sessionState(limits, lastActivity() ?? now, now);
  return state.phase === 'expired' && state.kind ? { kind: state.kind, limits } : null;
}

/** Why the session ended, said after the sign-out (webmail shows it on the login page). */
export function announceSessionEnd(kind: SessionEndKind, limits: SessionLimits, draftsUnsaved = false): void {
  const title = kind === 'max'
    ? t('session_limits.reason_max', 'You were signed out because your session reached its maximum length of {hours, plural, one {# hour} other {# hours}}.', { hours: limits.max?.hours ?? 0 })
    : t('session_limits.reason_idle', 'You were signed out after {minutes, plural, one {# minute} other {# minutes}} without activity.', { minutes: limits.idle?.minutes ?? 0 });
  useToastStore.getState().addToast({
    type: draftsUnsaved ? 'warning' : 'info',
    title,
    ...(draftsUnsaved ? { message: t('session_limits.drafts_not_saved', 'One or more open messages could not be saved as drafts.') } : {}),
  });
}

/**
 * End the session for a limit: the open composers save their drafts (kept on
 * the device when the server doesn't take them), then every account signs
 * out through the app's sign-out, and the reason is said.
 */
export async function endSessionForLimit(
  kind: SessionEndKind,
  signOut: () => Promise<void>,
): Promise<void> {
  const limits = currentSessionLimits();
  const flushed = await flushComposers(DRAFT_FLUSH_TIMEOUT_MS);
  await signOut();
  announceSessionEnd(kind, limits, flushed.failed > 0 || flushed.timedOut);
}
