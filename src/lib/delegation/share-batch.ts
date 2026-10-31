/**
 * Changing the `shareWith` of many folders, calendars, address books and
 * files in one go, for the Delegates page (webmail lib/jmap/share-batch.ts):
 * the method calls for one request and a result for every item, so a
 * partial failure can say what failed.
 * The single-item helpers (setCalendarShare, setFileNodeShare) send the same
 * `shareWith/<principalId>` patch.
 */

import { batched } from '../../api/jmap-result';
import type { AnyRights, ShareKind } from './share-rights';

/** One shareable item of the user's own account, with its grants. */
export interface ShareTarget {
  kind: ShareKind;
  accountId: string;
  /** The id in `accountId`. */
  id: string;
  name: string;
  /** Mailboxes: the folder role ("inbox", "sent", ...). */
  role?: string | null;
  parentId?: string | null;
  /** Calendars and address books: the account's default one. */
  isDefault?: boolean;
  shareWith: Record<string, AnyRights>;
}

/** Grant (`rights`) or revoke (`null`) one principal's access to one item. */
export interface ShareChange {
  kind: ShareKind;
  accountId: string;
  id: string;
  name: string;
  principalId: string;
  rights: AnyRights | null;
}

export interface ShareChangeResult {
  change: ShareChange;
  ok: boolean;
  /** The server's reason, when it gave one. */
  error?: string;
}

type MethodCall = [string, Record<string, unknown>, string];
type MethodResponse = [string, Record<string, unknown>, string];

export const SET_METHOD: Record<ShareKind, string> = {
  mailbox: 'Mailbox/set',
  calendar: 'Calendar/set',
  addressBook: 'AddressBook/set',
  file: 'FileNode/set',
};

export interface ShareSetCalls {
  calls: MethodCall[];
  /** The changes each call carries, by call id. */
  changesByCall: Map<string, ShareChange[]>;
}

/**
 * One /set call per type and account, split so none touches more than
 * `maxObjectsInSet` items. `wireRights` lets the caller convert rights for
 * a server that names them differently (old file rights).
 */
export function buildShareSetCalls(
  changes: ShareChange[],
  options: { maxObjectsInSet: number; wireRights?: (change: ShareChange) => unknown },
): ShareSetCalls {
  const groups = new Map<string, ShareChange[]>();
  for (const change of changes) {
    const key = `${change.kind}\u0000${change.accountId}`;
    const list = groups.get(key);
    if (list) list.push(change);
    else groups.set(key, [change]);
  }

  const calls: MethodCall[] = [];
  const changesByCall = new Map<string, ShareChange[]>();
  for (const group of groups.values()) {
    const { kind, accountId } = group[0];
    // Batch by item, not by change: two principals on one item are one object.
    const ids = [...new Set(group.map((c) => c.id))];
    for (const idBatch of batched(ids, options.maxObjectsInSet)) {
      const inBatch = new Set(idBatch);
      const batchChanges = group.filter((c) => inBatch.has(c.id));
      const update: Record<string, Record<string, unknown>> = {};
      for (const change of batchChanges) {
        const rights = change.rights && options.wireRights ? options.wireRights(change) : change.rights;
        (update[change.id] ??= {})[`shareWith/${change.principalId}`] = rights;
      }
      const callId = `s${calls.length}`;
      calls.push([SET_METHOD[kind], { accountId, update }, callId]);
      changesByCall.set(callId, batchChanges);
    }
  }
  return { calls, changesByCall };
}

function describe(error: unknown): string | undefined {
  const e = error as { description?: unknown; type?: unknown } | undefined;
  if (typeof e?.description === 'string' && e.description) return e.description;
  if (typeof e?.type === 'string' && e.type) return e.type;
  return undefined;
}

/** A result for every change of `calls`, from the responses to them. */
export function readShareSetResults(
  calls: MethodCall[],
  changesByCall: Map<string, ShareChange[]>,
  responses: MethodResponse[] | undefined,
): ShareChangeResult[] {
  const results: ShareChangeResult[] = [];
  for (const [, , callId] of calls) {
    const changes = changesByCall.get(callId) ?? [];
    const response = responses?.find((r) => r[2] === callId);
    if (!response) {
      for (const change of changes) results.push({ change, ok: false });
      continue;
    }
    const [name, result] = response;
    if (name === 'error') {
      const error = describe(result);
      for (const change of changes) results.push({ change, ok: false, error });
      continue;
    }
    const updated = (result.updated ?? {}) as Record<string, unknown>;
    const notUpdated = (result.notUpdated ?? {}) as Record<string, unknown>;
    for (const change of changes) {
      if (change.id in notUpdated) results.push({ change, ok: false, error: describe(notUpdated[change.id]) });
      else if (change.id in updated) results.push({ change, ok: true });
      else results.push({ change, ok: false });
    }
  }
  return results;
}

/** Every change of `calls` failed with one error (the request didn't go through). */
export function failAll(calls: MethodCall[], changesByCall: Map<string, ShareChange[]>, error: unknown): ShareChangeResult[] {
  const message = error instanceof Error ? error.message : describe(error);
  return calls.flatMap(([, , callId]) => (changesByCall.get(callId) ?? []).map((change) => ({ change, ok: false, error: message })));
}

function asShareWith(value: unknown): Record<string, AnyRights> {
  return value && typeof value === 'object' ? (value as Record<string, AnyRights>) : {};
}

/**
 * The items of a Mailbox/get, Calendar/get and AddressBook/get response
 * (call ids `m`, `c`, `a`), and the types whose call failed.
 */
export function parseShareTargets(
  responses: MethodResponse[] | undefined,
  accounts: { mailbox?: string; calendar?: string; addressBook?: string },
): { targets: ShareTarget[]; failed: ShareKind[] } {
  const targets: ShareTarget[] = [];
  const failed: ShareKind[] = [];
  const read = (kind: ShareKind, callId: string, method: string, accountId: string | undefined) => {
    if (!accountId) return;
    const response = responses?.find((r) => r[2] === callId);
    if (!response || response[0] !== method) {
      failed.push(kind);
      return;
    }
    const list = (response[1].list ?? []) as Array<Record<string, unknown>>;
    for (const item of list) {
      if (typeof item.id !== 'string') continue;
      targets.push({
        kind,
        accountId,
        id: item.id,
        name: typeof item.name === 'string' ? item.name : item.id,
        ...(kind === 'mailbox' ? { role: (item.role as string | null | undefined) ?? null, parentId: (item.parentId as string | null | undefined) ?? null } : {}),
        ...(kind !== 'mailbox' ? { isDefault: item.isDefault === true } : {}),
        shareWith: asShareWith(item.shareWith),
      });
    }
  };
  read('mailbox', 'm', 'Mailbox/get', accounts.mailbox);
  read('calendar', 'c', 'Calendar/get', accounts.calendar);
  read('addressBook', 'a', 'AddressBook/get', accounts.addressBook);
  return { targets, failed };
}
