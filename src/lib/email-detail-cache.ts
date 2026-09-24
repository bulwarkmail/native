// The messages the viewer has read, kept across viewer instances so opening a
// message again (or swiping back to it) paints its body at once instead of
// waiting for the network.
//
// A body never changes once a message exists (RFC 8621 §4.1): only its
// keywords and mailboxes do. So a copy held here is shown straight away and
// revalidated in the background, and only when something may have changed:
// the account's Email state moved on since the copy was read, or the list row
// the viewer was opened from disagrees with it. Revalidating asks for just the
// keywords and mailboxes. Concurrent loads of the same message or thread share
// one request, which is what stops the pager's panes and a tap's prefetch from
// fetching the same body twice.

import { AppState } from 'react-native';
import type { Email } from '../api/types';
import { jmapClient } from '../api/jmap-client';
import { getEmailFlags, getFullEmailsWithState, getThreadHeaders } from '../api/email';
import { useOfflineCacheStore } from '../stores/offline-cache-store';
import { useSettingsStore } from '../stores/settings-store';
import { onStateChangeType } from './state-change-bus';

/** What the list row the viewer was opened from says about the message. */
export type FlagsHint = Partial<Pick<Email, 'keywords' | 'mailboxIds'>>;

interface DetailEntry {
  email: Email;
  /** The account's Email state this copy was read or last checked at. */
  state?: string;
  /** Rough size of the bodies, for the memory cap. */
  chars: number;
}

interface ThreadEntry {
  /** Member ids, oldest first. */
  ids: string[];
  /** Members without bodies (list properties). */
  headers: Map<string, Email>;
  state?: string;
}

export interface ThreadView {
  ids: string[];
  headers: ReadonlyMap<string, Email>;
}

// Large newsletters run to hundreds of KB, so the cap is by size as well as count.
const MAX_DETAILS = 40;
const MAX_DETAIL_CHARS = 8_000_000;
const MAX_THREADS = 60;
// List rows handed to the viewer by screens whose list it cannot read (the
// Unified Inbox, contact activity), so it can paint their headers too.
const MAX_ROWS = 500;

const details = new Map<string, DetailEntry>();
const threads = new Map<string, ThreadEntry>();
const rows = new Map<string, Email>();
const pendingDetails = new Map<string, Promise<Email>>();
const pendingThreads = new Map<string, Promise<ThreadView>>();
// The newest Email state heard of per account, from push and our own reads.
const latestStates = new Map<string, string>();
const listeners = new Set<() => void>();
let detailChars = 0;
let wired = false;
// Bumped by clearEmailDetailCache: a load started before must not refill it.
let generation = 0;

// JMAP ids are only unique per account (RFC 8621 §1.3), and two signed-in
// servers can hand out the same account ids, so the key names both.
function accountKey(accountId: string | undefined): string {
  let own = '';
  try { own = jmapClient.accountId; } catch { /* not connected */ }
  return `${jmapClient.serverUrl ?? ''}|${jmapClient.username ?? ''}|${accountId ?? own}`;
}

function keyOf(id: string, accountId: string | undefined): string {
  return `${accountKey(accountId)}|${id}`;
}

function bodyChars(email: Email): number {
  let n = 2_000;
  for (const v of Object.values(email.bodyValues ?? {})) n += v?.value?.length ?? 0;
  return n;
}

function emit(): void {
  for (const l of listeners) {
    try { l(); } catch { /* a broken listener must not break the others */ }
  }
}

// The Email state is only worth trusting while push is delivering changes:
// events that happen while the app is in the background are lost.
function wire(): void {
  if (wired) return;
  wired = true;
  onStateChangeType('Email', (accountId, state) => {
    latestStates.set(accountKey(accountId), state);
  });
  try {
    AppState.addEventListener('change', (next) => {
      if (next !== 'active') latestStates.clear();
    });
  } catch { /* no AppState (tests) */ }
}

/** Record the account's current Email state (push event or a response). */
export function noteEmailState(accountId: string | undefined, state: string | undefined): void {
  if (state) latestStates.set(accountKey(accountId), state);
}

function sameFlags(a: Record<string, boolean> | undefined, b: Record<string, boolean> | undefined): boolean {
  const ak = Object.keys(a ?? {}).filter((k) => a![k]);
  const bk = Object.keys(b ?? {}).filter((k) => b![k]);
  return ak.length === bk.length && ak.every((k) => !!b?.[k]);
}

/**
 * Whether a copy read at `copyState` has to be checked against the server
 * before it is trusted: the account's Email state is unknown or has moved on,
 * or the list row the message was opened from disagrees with the copy.
 */
export function needsRevalidation(
  copy: Pick<Email, 'keywords' | 'mailboxIds'>,
  copyState: string | undefined,
  latestState: string | undefined,
  hint?: FlagsHint,
): boolean {
  if (!copyState || !latestState || copyState !== latestState) return true;
  if (hint?.keywords && !sameFlags(hint.keywords, copy.keywords)) return true;
  if (hint?.mailboxIds && !sameFlags(hint.mailboxIds, copy.mailboxIds)) return true;
  return false;
}

function putDetail(key: string, entry: DetailEntry): void {
  const prev = details.get(key);
  if (prev) {
    detailChars -= prev.chars;
    details.delete(key);
  }
  details.set(key, entry);
  detailChars += entry.chars;
  // Evict least recently used, never the entry just stored.
  for (const [k, e] of details) {
    if (details.size <= MAX_DETAILS && detailChars <= MAX_DETAIL_CHARS) break;
    if (k === key) continue;
    details.delete(k);
    detailChars -= e.chars;
  }
}

function touchDetail(key: string, entry: DetailEntry): void {
  details.delete(key);
  details.set(key, entry);
}

function putThread(key: string, entry: ThreadEntry): void {
  threads.delete(key);
  threads.set(key, entry);
  while (threads.size > MAX_THREADS) {
    const oldest = threads.keys().next().value as string;
    threads.delete(oldest);
  }
}

/** The copy held for a message, if any. Synchronous: for rendering. */
export function peekDetail(id: string, accountId?: string): Email | undefined {
  return details.get(keyOf(id, accountId))?.email;
}

/** The conversation held for a thread, if any. */
export function peekThread(threadId: string, accountId?: string): ThreadView | undefined {
  return threads.get(keyOf(threadId, accountId));
}

/** Re-render on every change to what is held here. */
export function subscribeEmailCache(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Apply a local change (star, read, tag, `$answered`…) to the held copy and to
 * any conversation that lists the message, so the next open shows it.
 */
export function patchDetail(id: string, accountId: string | undefined, patch: FlagsHint): void {
  const key = keyOf(id, accountId);
  let changed = false;
  const entry = details.get(key);
  if (entry) {
    details.set(key, { ...entry, email: { ...entry.email, ...patch } });
    changed = true;
  }
  const prefix = accountKey(accountId);
  for (const [k, thread] of threads) {
    if (!k.startsWith(`${prefix}|`)) continue;
    const header = thread.headers.get(id);
    if (!header) continue;
    const headers = new Map(thread.headers);
    headers.set(id, { ...header, ...patch });
    threads.set(k, { ...thread, headers });
    changed = true;
  }
  if (changed) emit();
}

/**
 * Drop everything held, and keep loads still in flight from storing what
 * they bring (sign-out, account removal).
 */
export function clearEmailDetailCache(): void {
  generation++;
  details.clear();
  threads.clear();
  rows.clear();
  pendingDetails.clear();
  pendingThreads.clear();
  latestStates.clear();
  detailChars = 0;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  // Callers may drop the promise (prefetch); an unobserved rejection is noise.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

// Keep the offline copy's keywords/folders current: the next offline open
// should not show a star or a folder from weeks ago.
function refreshOfflineCopy(email: Email, accountId: string | undefined): void {
  const offline = useOfflineCacheStore.getState();
  if (!offline.has(email.id, accountId)) return;
  try {
    void offline.put(email, JSON.stringify(email).length, accountId).catch(() => undefined);
  } catch { /* best effort */ }
}

async function fetchBodies(
  ids: string[],
  accountId: string | undefined,
  waiting: Map<string, Deferred<Email>>,
): Promise<void> {
  if (ids.length === 0) return;
  const gen = generation;
  try {
    const res = await getFullEmailsWithState(ids, accountId);
    const keep = gen === generation;
    if (keep) noteEmailState(accountId, res.state);
    const found = new Map<string, Email>();
    for (const email of res.list) {
      found.set(email.id, email);
      if (!keep) continue;
      putDetail(keyOf(email.id, accountId), { email, state: res.state, chars: bodyChars(email) });
      refreshOfflineCopy(email, accountId);
    }
    if (keep) emit();
    for (const id of ids) {
      const email = found.get(id);
      if (email) waiting.get(id)?.resolve(email);
      else waiting.get(id)?.reject(new Error(`Email ${id} not found`));
    }
  } catch (err) {
    for (const id of ids) waiting.get(id)?.reject(err);
  }
}

async function revalidate(
  ids: string[],
  accountId: string | undefined,
  waiting: Map<string, Deferred<Email>>,
): Promise<void> {
  if (ids.length === 0) return;
  const gen = generation;
  let gone = new Set<string>();
  try {
    const res = await getEmailFlags(ids, accountId);
    if (gen !== generation) throw new Error('cleared');
    noteEmailState(accountId, res.state);
    gone = new Set(res.notFound);
    let changed = false;
    for (const flags of res.list) {
      const key = keyOf(flags.id, accountId);
      const entry = details.get(key);
      if (!entry) continue;
      const same = sameFlags(flags.keywords, entry.email.keywords)
        && sameFlags(flags.mailboxIds, entry.email.mailboxIds);
      // Keep the object when nothing changed, so nothing re-renders.
      const email = same ? entry.email : { ...entry.email, keywords: flags.keywords, mailboxIds: flags.mailboxIds };
      details.set(key, { ...entry, email, state: res.state });
      if (!same) {
        changed = true;
        refreshOfflineCopy(email, accountId);
      }
    }
    // Destroyed since it was read: not something to show as current.
    for (const id of gone) {
      const key = keyOf(id, accountId);
      const entry = details.get(key);
      if (!entry) continue;
      details.delete(key);
      detailChars -= entry.chars;
      changed = true;
    }
    if (changed) emit();
  } catch {
    // Offline or refused: the copy held is still the best there is.
  }
  for (const id of ids) {
    const email = peekDetail(id, accountId);
    if (email) waiting.get(id)?.resolve(email);
    else waiting.get(id)?.reject(new Error(`Email ${id} not found`));
  }
}

/**
 * Start loading messages, cache first, and return a promise per id:
 *  - a held copy that is still current resolves at once;
 *  - one that may be stale is shown and checked with a single
 *    keywords/folders request for all of them;
 *  - a copy in the offline cache is shown, then checked the same way;
 *  - only the rest are downloaded, in one `Email/get`.
 * A load already running for an id is joined instead of repeated.
 */
function startLoads(
  ids: string[],
  accountId: string | undefined,
  hints?: Record<string, FlagsHint | undefined>,
): Map<string, Promise<Email>> {
  wire();
  const latest = latestStates.get(accountKey(accountId));
  const offline = useOfflineCacheStore.getState();
  const results = new Map<string, Promise<Email>>();
  const waiting = new Map<string, Deferred<Email>>();
  const stale: string[] = [];
  const fromOffline: string[] = [];
  const missing: string[] = [];

  for (const id of new Set(ids)) {
    const key = keyOf(id, accountId);
    const pending = pendingDetails.get(key);
    if (pending) {
      results.set(id, pending);
      continue;
    }
    const entry = details.get(key);
    if (entry) {
      touchDetail(key, entry);
      if (!needsRevalidation(entry.email, entry.state, latest, hints?.[id])) {
        results.set(id, Promise.resolve(entry.email));
        continue;
      }
    }
    const d = deferred<Email>();
    waiting.set(id, d);
    results.set(id, d.promise);
    pendingDetails.set(key, d.promise);
    const done = () => { if (pendingDetails.get(key) === d.promise) pendingDetails.delete(key); };
    d.promise.then(done, done);
    if (entry) stale.push(id);
    else if (offline.has(id, accountId)) fromOffline.push(id);
    else missing.push(id);
  }
  if (waiting.size === 0) return results;

  void (async () => {
    // An offline copy is shown right away, then checked like a held one.
    if (fromOffline.length > 0) {
      const gen = generation;
      const copies = await Promise.all(fromOffline.map((id) => offline.get(id, accountId).catch(() => null)));
      let shown = false;
      fromOffline.forEach((id, i) => {
        const email = gen === generation ? copies[i] : null;
        if (!email) {
          missing.push(id);
          return;
        }
        putDetail(keyOf(id, accountId), { email, chars: bodyChars(email) });
        stale.push(id);
        shown = true;
      });
      if (shown) emit();
    }
    await Promise.all([
      fetchBodies(missing, accountId, waiting),
      revalidate(stale, accountId, waiting),
    ]);
  })();
  return results;
}

/** Load several messages (see {@link startLoads}); ones that failed are left out. */
export async function loadDetails(
  ids: string[],
  accountId?: string,
  hints?: Record<string, FlagsHint | undefined>,
): Promise<Map<string, Email>> {
  const out = new Map<string, Email>();
  await Promise.all(Array.from(startLoads(ids, accountId, hints), async ([id, p]) => {
    try { out.set(id, await p); } catch { /* left out */ }
  }));
  return out;
}

/**
 * Load one message (see {@link startLoads}). Resolves with the checked copy,
 * which is what decisions like mark-as-read must be based on; rejects when
 * the message cannot be loaded.
 */
export function loadDetail(id: string, accountId?: string, hint?: FlagsHint): Promise<Email> {
  return startLoads([id], accountId, hint ? { [id]: hint } : undefined).get(id)!;
}

/**
 * A conversation's members without bodies, cache first. A held conversation
 * resolves at once while the account's Email state says it is current; it is
 * otherwise refetched (one request) and, if that fails, still returned.
 */
export function loadThread(threadId: string, accountId?: string): Promise<ThreadView> {
  wire();
  const key = keyOf(threadId, accountId);
  const held = threads.get(key);
  const latest = latestStates.get(accountKey(accountId));
  if (held && held.state && held.state === latest) return Promise.resolve(held);
  const pending = pendingThreads.get(key);
  if (pending) return pending;
  const gen = generation;
  const p = getThreadHeaders(threadId, accountId)
    .then((res) => {
      if (gen !== generation) throw new Error('cleared');
      noteEmailState(accountId, res.state);
      const entry: ThreadEntry = {
        ids: res.emailIds,
        headers: new Map(res.list.map((e) => [e.id, e])),
        state: res.state,
      };
      putThread(key, entry);
      // The headers were just read: a member's copy held from an earlier
      // open takes their keywords and folders, which may have changed since.
      for (const header of res.list) {
        const memberKey = keyOf(header.id, accountId);
        const held = details.get(memberKey);
        if (!held) continue;
        if (sameFlags(header.keywords, held.email.keywords) && sameFlags(header.mailboxIds, held.email.mailboxIds)) {
          continue;
        }
        details.set(memberKey, {
          ...held,
          email: { ...held.email, keywords: header.keywords, mailboxIds: header.mailboxIds },
          state: res.state,
        });
      }
      emit();
      return entry as ThreadView;
    })
    .catch((err) => {
      if (held && gen === generation) return held as ThreadView;
      throw err;
    })
    .finally(() => { if (pendingThreads.get(key) === p) pendingThreads.delete(key); });
  pendingThreads.set(key, p);
  return p;
}

/** Keep list rows the viewer may page over; see {@link peekRow}. */
export function rememberRows(list: Email[], accountId?: string): void {
  for (const row of list) {
    if (!row.receivedAt) continue;
    const key = keyOf(row.id, accountId);
    rows.delete(key);
    rows.set(key, row);
  }
  while (rows.size > MAX_ROWS) rows.delete(rows.keys().next().value as string);
}

/** A list row remembered for the message, if any. */
export function peekRow(id: string, accountId?: string): Email | undefined {
  return rows.get(keyOf(id, accountId));
}

/**
 * Start loading a message the user is about to open (the list row was
 * tapped), and its conversation when threading is on, so the viewer finds the
 * requests in flight or done. On a phone this runs on the tap, not on
 * press-in: a touch that starts a scroll presses rows too.
 */
export function prefetchMessage(
  email: Pick<Email, 'id' | 'threadId'> & Partial<Email>,
  accountId?: string,
): void {
  rememberRows([email as Email], accountId);
  const hint = email.keywords ? { keywords: email.keywords, mailboxIds: email.mailboxIds } : undefined;
  void loadDetail(email.id, accountId, hint).catch(() => undefined);
  if (email.threadId && !useSettingsStore.getState().disableThreading) {
    void loadThread(email.threadId, accountId).catch(() => undefined);
  }
}
