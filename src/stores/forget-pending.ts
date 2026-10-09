// Sign-out cleanups that have not finished, kept on disk so the next cold
// start can finish one the app was killed in. A sign-out waits for its
// device cleanup only so long and lets the rest run in the background; a kill
// then would leave the signed-out account's identities, queued sends the user
// chose to discard and calendar feed URLs on the device for good.
//
// One row, a list with one entry per cleanup key (an app account id, or
// SHARED_CLEANUP for the data every account shares). auth-store owns the
// lifecycle; this module only reads and writes the row, and imports no store.

import AsyncStorage from '@react-native-async-storage/async-storage';

/** The cleanup key of the data every account shares (the search history, ownerless subscriptions). */
export const SHARED_CLEANUP = '\u0000shared';

export const FORGET_PENDING_KEY = 'auth:forgetPending:v1';

export type ForgetPendingEntry =
  | { key: string; kind: 'signOut'; serverUrl?: string | null; username?: string | null; discardQueuedSends?: boolean; withShared: boolean }
  | { key: string; kind: 'evict'; serverUrl?: string | null; username?: string | null }
  | { key: typeof SHARED_CLEANUP; kind: 'shared' };

const optionalText = (v: unknown) => v === undefined || v === null || typeof v === 'string';

// An entry this version can run. The shared key only ever names the shared
// cleanup, and an account cleanup never runs under it.
function isEntry(v: unknown): v is ForgetPendingEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  if (typeof e.key !== 'string' || !e.key) return false;
  if (e.kind === 'shared') return e.key === SHARED_CLEANUP;
  if (e.key === SHARED_CLEANUP) return false;
  if (!optionalText(e.serverUrl) || !optionalText(e.username)) return false;
  if (e.kind === 'evict') return true;
  return e.kind === 'signOut'
    && typeof e.withShared === 'boolean'
    && (e.discardQueuedSends === undefined || typeof e.discardQueuedSends === 'boolean');
}

// The row as stored. Anything it cannot use reads as nothing, with one
// warning per read: a cleanup it cannot read cannot be finished either.
async function readRow(): Promise<ForgetPendingEntry[]> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(FORGET_PENDING_KEY);
  } catch (e) {
    console.warn('[sign-out] could not read the pending cleanups', e);
    return [];
  }
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[sign-out] pending cleanups unreadable, ignoring them');
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn('[sign-out] pending cleanups unreadable, ignoring them');
    return [];
  }
  const entries = parsed.filter(isEntry);
  if (entries.length !== parsed.length) console.warn('[sign-out] ignoring pending cleanups this version cannot run');
  return entries;
}

/** The cleanups left unfinished. Never throws. */
export function readForgetPending(): Promise<ForgetPendingEntry[]> {
  return readRow();
}

// Writes go one at a time, each reading the row afresh, so two made back to
// back never lose each other's change. A failed write does not stop the next.
let writes: Promise<unknown> = Promise.resolve();

function update(change: (entries: ForgetPendingEntry[]) => ForgetPendingEntry[]): Promise<void> {
  const next = writes.then(async () => {
    const entries = change(await readRow());
    if (entries.length) await AsyncStorage.setItem(FORGET_PENDING_KEY, JSON.stringify(entries));
    else await AsyncStorage.removeItem(FORGET_PENDING_KEY);
  });
  writes = next.catch(() => undefined);
  return next;
}

/** Note a cleanup as under way: one entry per key, replacing an earlier one. */
export function markForgetPending(entry: ForgetPendingEntry): Promise<void> {
  return update((entries) => {
    const at = entries.findIndex((e) => e.key === entry.key);
    if (at < 0) return [...entries, entry];
    const out = [...entries];
    out[at] = entry;
    return out;
  });
}

/** Drop the entry of a cleanup that has nothing left to do. */
export function clearForgetPending(key: string): Promise<void> {
  return update((entries) => entries.filter((e) => e.key !== key));
}
