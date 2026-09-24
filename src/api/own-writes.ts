// The app's own Email writes, as their responses report them.
//
// Every `Email/set` (also the implicit one `EmailSubmission/set` appends for
// `onSuccessUpdateEmail`), `Email/import` and `Email/copy` response carries
// the account's Email state before and after it. The server then pushes the
// new state back to us, and without this log that echo re-read the open list
// (Email/queryChanges, Email/changes, Email/get, Thread/get) to learn what we
// had just done ourselves. With it, the mail store can tell that every change
// between the state its list was read at and the pushed one was ours, apply
// them locally and skip the refresh (see absorbOwnEmailWrites).

import type { Email, JMAPMethodCall } from './types';
import { applyKeywordPatch } from '../lib/keyword-patch';
import { pointerTokenValue } from './patch-pointer';

type Patch = Record<string, unknown>;

export interface OwnEmailWrite {
  /** Server the write went to (JMAP account ids are only unique per server). */
  server: string;
  accountId: string;
  oldState: string;
  newState: string;
  /** Created messages and the folders they were created in (undefined when unknown). */
  created: Array<{ id: string; mailboxIds?: Record<string, boolean> }>;
  /** Updated messages and the patch that was sent (undefined when unknown). */
  updated: Array<{ id: string; patch?: Patch }>;
  destroyed: string[];
}

const MAX_WRITES = 64;
const WRITE_METHODS = new Set(['Email/set', 'Email/import', 'Email/copy', 'EmailSubmission/set']);

let writes: OwnEmailWrite[] = [];
let inFlight = 0;
let waiters: Array<() => void> = [];

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Mark a request as in flight when it may write mail; call the returned
 * function once it has settled (after {@link recordOwnEmailWrites}).
 */
export function beginOwnWrite(calls: ReadonlyArray<JMAPMethodCall>): () => void {
  if (!calls.some(([name]) => WRITE_METHODS.has(name))) return () => undefined;
  inFlight += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    inFlight -= 1;
    if (inFlight === 0) {
      const pending = waiters;
      waiters = [];
      for (const resolve of pending) resolve();
    }
  };
}

/**
 * Resolves once no mail write is in flight, or after `timeoutMs`. A push can
 * overtake the response of the write that caused it.
 */
export function whenOwnWritesSettled(timeoutMs: number): Promise<void> {
  if (inFlight === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters = waiters.filter((w) => w !== done);
      resolve();
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    waiters.push(done);
  });
}

/** Log the Email writes a successful request made. Never throws. */
export function recordOwnEmailWrites(
  server: string,
  calls: ReadonlyArray<JMAPMethodCall>,
  responses: ReadonlyArray<[string, Record<string, any>, string]> | undefined,
): void {
  if (!Array.isArray(responses)) return;
  try {
    record(server, calls, responses);
  } catch {
    // A malformed response only costs the echo its shortcut.
  }
}

function record(
  server: string,
  calls: ReadonlyArray<JMAPMethodCall>,
  responses: ReadonlyArray<[string, Record<string, any>, string]>,
): void {
  const callById = new Map(calls.map((call) => [call[2], call]));
  for (const [name, body, callId] of responses) {
    if (name !== 'Email/set' && name !== 'Email/import' && name !== 'Email/copy') continue;
    const call = callById.get(callId);
    if (!call || !isObject(body)) continue;
    const [method, args] = call;
    const accountId = (body.accountId ?? args.accountId) as unknown;
    const { oldState, newState } = body as { oldState?: unknown; newState?: unknown };
    // A write the server can't place between two states (or that changed
    // nothing) can't be matched against a push; leave it out.
    if (typeof accountId !== 'string' || typeof oldState !== 'string' || typeof newState !== 'string') continue;
    if (oldState === newState) continue;

    const write: OwnEmailWrite = { server, accountId, oldState, newState, created: [], updated: [], destroyed: [] };
    const createArgs = isObject(args.create) ? args.create : isObject(args.emails) ? args.emails : {};
    for (const [creationId, info] of Object.entries(isObject(body.created) ? body.created : {})) {
      const id = isObject(info) ? info.id : undefined;
      if (typeof id !== 'string') continue;
      const source = createArgs[creationId];
      const mailboxIds = isObject(source) && isObject(source.mailboxIds)
        ? (source.mailboxIds as Record<string, boolean>)
        : undefined;
      write.created.push({ id, mailboxIds });
    }
    // The implicit Email/set of a submission answers under the submission's
    // call id; its patch is the one `onSuccessUpdateEmail` named, if only one.
    let implicitPatch: Patch | undefined;
    if (method === 'EmailSubmission/set' && isObject(args.onSuccessUpdateEmail)) {
      const patches = Object.values(args.onSuccessUpdateEmail);
      if (patches.length === 1 && isObject(patches[0])) implicitPatch = patches[0];
    }
    const updateArgs = method === 'Email/set' && isObject(args.update) ? args.update : {};
    for (const id of Object.keys(isObject(body.updated) ? body.updated : {})) {
      const patch = method === 'Email/set' ? updateArgs[id] : implicitPatch;
      write.updated.push({ id, patch: isObject(patch) ? patch : undefined });
    }
    if (Array.isArray(body.destroyed)) {
      write.destroyed.push(...body.destroyed.filter((id): id is string => typeof id === 'string'));
    }
    writes.push(write);
  }
  if (writes.length > MAX_WRITES) writes = writes.slice(-MAX_WRITES);
}

/**
 * Our own writes that lead from `fromState` to `toState` of an account, in
 * order: [] when the states are equal, null when anything else (another
 * client, new mail, a write we didn't log) happened in between.
 */
export function ownEmailWritesBetween(
  server: string,
  accountId: string,
  fromState: string,
  toState: string,
): OwnEmailWrite[] | null {
  const chain: OwnEmailWrite[] = [];
  let state = fromState;
  while (state !== toState) {
    const next = writes.find((w) => w.server === server && w.accountId === accountId && w.oldState === state);
    if (!next || chain.includes(next)) return null;
    chain.push(next);
    state = next.newState;
  }
  return chain;
}

/** Test hook; also forgets writes of a signed-out account. */
export function resetOwnWrites(): void {
  writes = [];
}

export interface OwnWriteListView {
  /** Rows the list shows now. */
  emails: Email[];
  /** Ids of the rows the list was last read from the server with. */
  syncedIds: ReadonlySet<string>;
  /** Raw JMAP id of the folder the list shows. */
  folderId: string;
  /** Keywords the list is sorted on: changing one moves rows. */
  sortKeywords: ReadonlySet<string>;
}

/**
 * The folder list with `chain` applied, and how many of its messages the
 * writes took out of the folder; null when the writes change the list in a
 * way only a re-query can show (a message added to the folder, a sort
 * keyword changed, an unknown change to a loaded row, a loaded-window change
 * of a message we don't hold).
 */
export function applyOwnWritesToList(
  chain: ReadonlyArray<OwnEmailWrite>,
  view: OwnWriteListView,
): { emails: Email[]; removed: number } | null {
  const rows = new Map(view.emails.map((e) => [e.id, e]));
  const gone = new Set<string>();
  const known = (id: string) => rows.has(id) || view.syncedIds.has(id);
  // Joining the folder is only a no-op for a row the last read already had
  // (not one an undo put back on screen by date).
  const stays = (id: string) => rows.has(id) && view.syncedIds.has(id);
  const leave = (id: string) => {
    if (known(id)) gone.add(id);
    rows.delete(id);
  };

  for (const write of chain) {
    for (const c of write.created) {
      if (!c.mailboxIds || c.mailboxIds[view.folderId]) return null;
    }
    for (const id of write.destroyed) leave(id);
    for (const { id, patch } of write.updated) {
      if (!patch) {
        if (known(id)) return null;
        continue;
      }
      const keywords: Record<string, boolean | null> = {};
      let leaves = false;
      for (const [key, value] of Object.entries(patch)) {
        if (key.startsWith('keywords/')) {
          const keyword = pointerTokenValue(key.slice('keywords/'.length));
          if (view.sortKeywords.has(keyword)) return null;
          keywords[keyword] = value ? true : null;
        } else if (key.startsWith('mailboxIds/')) {
          if (pointerTokenValue(key.slice('mailboxIds/'.length)) !== view.folderId) continue;
          if (value) {
            if (!stays(id)) return null;
          } else if (known(id)) {
            leaves = true;
          } else {
            return null;
          }
        } else if (key === 'mailboxIds' && isObject(value)) {
          if (value[view.folderId]) {
            if (!stays(id)) return null;
          } else {
            leaves = true;
          }
        } else if (known(id)) {
          return null;
        }
      }
      if (leaves) {
        leave(id);
        continue;
      }
      const row = rows.get(id);
      if (row && Object.keys(keywords).length > 0) {
        rows.set(id, { ...row, keywords: applyKeywordPatch(row.keywords, keywords) });
      }
    }
  }

  const emails = view.emails.flatMap((e) => {
    const row = rows.get(e.id);
    return row ? [row] : [];
  });
  return { emails, removed: gone.size };
}
