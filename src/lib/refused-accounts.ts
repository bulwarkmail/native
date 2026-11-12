import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { useAccountStore } from '../stores/account-store';
import { useEmailStore } from '../stores/email-store';
import { useOfflineCacheStore } from '../stores/offline-cache-store';
import { useOutboxStore } from '../stores/outbox-store';
import { useContactsStore } from '../stores/contacts-store';
import { useCalendarStore } from '../stores/calendar-store';
import { useAuthStore } from '../stores/auth-store';
import { flushPersistedWrites } from '../stores/persist-storage';
import { clearRescuedDrafts } from './compose-rescue';
import { forgetCachedIdentities } from './identity-cache';
import { clearEmailDetailCache } from './email-detail-cache';
import { clearBodyDocuments } from './email-body-document';
import { clearBodyHeights } from './body-heights';
import { devicesForAccount } from './device-policy';
import { hasFullPolicy } from './account-organisation';

// An account the server refused (auth store keepForSignIn: `needsSignIn`)
// keeps its data on the device, hidden, until the user signs in again
// (webmail lib/offline/device-wipe.ts): the mail list shows the sign-in
// prompt instead, with how many unsent messages wait. After 30 days the
// data goes, or at once when the organisation asks for that
// (`organisation.devices.wipeOnForcedSignOut`). The account itself stays in
// the list, to be signed in to again.

/** How long a refused account's data stays hidden on the device (webmail EVICTED_KEEP_MS). */
export const REFUSED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

const STORAGE_KEY = 'bulwark.refused-accounts.v1';

interface RefusedEntry {
  /** When the server refused it. */
  since: number;
  /** Its data was deleted from the device. */
  wiped?: boolean;
}

interface RefusedState {
  byAccount: Record<string, RefusedEntry>;
  hydrated: boolean;
}

export const useRefusedAccounts = create<RefusedState>(() => ({ byAccount: {}, hydrated: false }));

function persist(): void {
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(useRefusedAccounts.getState().byAccount)).catch(() => undefined);
}

async function hydrate(): Promise<void> {
  if (useRefusedAccounts.getState().hydrated) return;
  let stored: Record<string, RefusedEntry> = {};
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        const v = value as Partial<RefusedEntry> | null;
        if (v && typeof v.since === 'number' && Number.isFinite(v.since)) stored[id] = { since: v.since, ...(v.wiped ? { wiped: true } : {}) };
      }
    }
  } catch {
    stored = {};
  }
  useRefusedAccounts.setState({ byAccount: { ...stored, ...useRefusedAccounts.getState().byAccount }, hydrated: true });
}

/**
 * Delete what the device keeps of an account, its unsent mail included:
 * its mail lists and bodies, the offline copies, the outbox, the drafts
 * kept on the device and the identities. Shared stores (contacts,
 * calendar, the message viewer) go too when it is the account on screen.
 */
export async function dropAccountData(accountId: string): Promise<void> {
  const steps: Array<() => unknown> = [
    () => useEmailStore.getState().removeAccount(accountId),
    () => useOfflineCacheStore.getState().clearAccount(accountId),
    () => useOutboxStore.getState().clearAccount(accountId),
    () => clearRescuedDrafts(accountId),
    () => forgetCachedIdentities(accountId),
  ];
  if (useAuthStore.getState().activeAccountId === accountId) {
    steps.push(
      () => useContactsStore.getState().reset(),
      () => useCalendarStore.getState().reset(),
      () => { clearEmailDetailCache(); clearBodyDocuments(); clearBodyHeights(); },
    );
  }
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      console.warn('[refused-accounts] dropping data failed', err);
    }
  }
  await flushPersistedWrites().catch(() => undefined);
}

/**
 * Follow the refused accounts: note when each was refused, drop the note
 * once it is signed in again, and delete the data of one refused 30 days
 * ago, or at once when its organisation asks for that. The organisation's
 * word counts only from its full policy (a refused token gets the public
 * part only). `now` is for tests.
 */
export async function sweepRefusedAccounts(now: number = Date.now()): Promise<void> {
  await hydrate();
  const accounts = useAccountStore.getState().accounts;
  const byAccount = { ...useRefusedAccounts.getState().byAccount };
  let changed = false;
  for (const id of Object.keys(byAccount)) {
    const account = accounts.find((a) => a.id === id);
    if (!account || !account.needsSignIn) {
      delete byAccount[id];
      changed = true;
    }
  }
  const toWipe: string[] = [];
  for (const account of accounts) {
    if (!account.needsSignIn) continue;
    const entry = byAccount[account.id] ?? { since: now };
    if (!byAccount[account.id]) {
      byAccount[account.id] = entry;
      changed = true;
    }
    if (entry.wiped) continue;
    const expired = now - entry.since >= REFUSED_KEEP_MS;
    const orgWipe = hasFullPolicy(account.id) && devicesForAccount(account.id).wipeOnForcedSignOut;
    if (expired || orgWipe) {
      byAccount[account.id] = { ...entry, wiped: true };
      changed = true;
      toWipe.push(account.id);
    }
  }
  if (changed) {
    useRefusedAccounts.setState({ byAccount });
    persist();
  }
  for (const id of toWipe) await dropAccountData(id);
}

/** When a refused account's data goes, or null when it isn't refused (or is gone already). */
export function refusedDataGoesAt(entry: RefusedEntry | undefined): number | null {
  if (!entry || entry.wiped) return null;
  return entry.since + REFUSED_KEEP_MS;
}

/** The active account, when the server refused it and its mail is to stay hidden. */
export function useRefusedActiveAccount(): string | null {
  const activeId = useAuthStore((s) => s.activeAccountId);
  const refused = useAccountStore((s) => (activeId ? s.accounts.find((a) => a.id === activeId)?.needsSignIn === true : false));
  return refused ? activeId : null;
}
