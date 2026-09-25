// EmailSubmission records. Every send leaves one behind. Stalwart 1.0 counts
// all of them, whatever their status or age, against a per-account limit
// (`maxSubmissions`, 500 by default), and its own purge of old records never
// runs, so an account that never removes them stops sending for good.
// Destroying a record only removes the record - on 0.16 and 1.0 it neither
// cancels nor stops the delivery - but a still-pending submission whose record
// is gone can no longer be cancelled. So only records that can't be cancelled
// any more are ever destroyed. Port of the webmail's client (48382170).

import { jmapClient } from './jmap-client';
import {
  SubmissionQuotaError, batched, jmapErrorType, requireMethodResult, type RefusedRecipient,
} from './jmap-result';
import { CAPABILITIES } from './types';
import type { JMAPMethodCall, JMAPResponseBody } from './types';
import { debug } from '../lib/debug';

/** `using` for EmailSubmission calls that neither read nor write an Email. */
export const SUBMISSION_ONLY_USING = [CAPABILITIES.CORE, CAPABILITIES.SUBMISSION];

/** How often the background prune may sweep one account's records. */
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;
/**
 * How long an account where making room found nothing that could go is not
 * searched again; see makeRoomForSubmission.
 */
const ROOM_RECHECK_MS = 5 * 60 * 1000;
/** Upper bound on the pages one prune, change-log walk or scheduled list reads. */
export const SUBMISSION_SCAN_MAX_PAGES = 40;

/** When each account's records were last pruned, keyed by server and account. */
const prunedAt = new Map<string, number>();
/** Accounts where making room found nothing to free, until when (epoch ms). */
const roomRecheckAt = new Map<string, number>();
/**
 * Shared accounts that advertise EmailSubmission but refused this login's
 * calls with `forbidden` (see pruneSubmissionAccount), keyed by server, login
 * and account. Left out of submissionAccountIds while the app runs.
 */
const refusedAccounts = new Set<string>();

function pruneKey(accountId: string): string {
  return `${jmapClient.serverUrl ?? ''}|${accountId}`;
}

/** Access is the login's: another login on the same server may be a member of the account. */
function refusalKey(accountId: string): string {
  return `${pruneKey(accountId)}|${jmapClient.username ?? ''}`;
}

/** Test hook. */
export function resetSubmissionPrune(): void {
  prunedAt.clear();
  roomRecheckAt.clear();
  refusedAccounts.clear();
}

/**
 * The accounts whose submission records this login reaches: the primary
 * submission account and every shared or group account advertising
 * submission, except those that refused them.
 */
export function submissionAccountIds(): string[] {
  return jmapClient.getSubmissionAccountIds().filter((id) => !refusedAccounts.has(refusalKey(id)));
}

/**
 * Whether the account is on Stalwart, whose destroy is known to leave the
 * delivery alone on every version. Only there does a send destroy its own
 * record right away; elsewhere the prune gets to it once it is final.
 */
export function isStalwartAccount(accountId: string): boolean {
  return jmapClient.hasAccountCapability('urn:stalwart:jmap', accountId);
}

/**
 * The error for a submission create the account refused with overQuota,
 * noting whether the account is on Stalwart: its limit is the count of
 * submission records, which only an administrator can raise once making room
 * freed nothing. Another server's may stand for any sending limit.
 */
export function submissionQuotaError(description: string | undefined, accountId: string): SubmissionQuotaError {
  return new SubmissionQuotaError(description, isStalwartAccount(accountId));
}

export interface SubmissionStatus {
  id: string;
  sendAt?: string | null;
  undoStatus?: string;
}

interface SetError {
  type?: string;
  description?: string;
}

/**
 * The submissions that can no longer be cancelled, going by the undoStatus
 * EmailSubmission/get reports: canceled ones, and final ones whose sendAt has
 * passed. Stalwart computes that status from its queue on every version, so
 * it is the one to trust - unlike the status a create returns (0.16.10-0.16.16
 * say final for a held send) or the query's undoStatus filter (0.16 matches
 * the stored status). A pending submission is never among them, whatever its
 * sendAt: the queue still holds its mail, held or retrying, and without the
 * record it could no longer be cancelled - while destroying it would not stop
 * the delivery either.
 */
export function prunableSubmissionIds(submissions: SubmissionStatus[], now: number): string[] {
  return submissions
    .filter((submission) => {
      if (submission.undoStatus === 'canceled') return true;
      if (submission.undoStatus !== 'final' || !submission.sendAt) return false;
      const sendAt = Date.parse(submission.sendAt);
      return Number.isFinite(sendAt) && sendAt <= now;
    })
    .map((submission) => submission.id);
}

/** The SetError an EmailSubmission/set create came back with, if it failed that way. */
export function submissionCreateError(res: JMAPResponseBody, creationId: string): SetError | undefined {
  return res.methodResponses
    ?.find(([name]) => name === 'EmailSubmission/set')?.[1]?.notCreated?.[creationId];
}

/**
 * EmailSubmission/get of the submission a /set creates in the same request,
 * named by its creation id; a result reference into the /set answer does not
 * resolve on 1.0. The server runs the SMTP RCPT stage while it creates the
 * submission - for a held send as well, only the delivery waits - and
 * records a refused recipient right away as `delivered: "no"` with its
 * reply. The create's own answer carries no deliveryStatus (0.16 and 1.0).
 */
export function deliveryStatusCall(accountId: string, creationId: string, callId: string): JMAPMethodCall {
  return ['EmailSubmission/get', { accountId, ids: [`#${creationId}`], properties: ['id', 'deliveryStatus'] }, callId];
}

/**
 * The recipients the server refused for a new submission, from the answer to
 * deliveryStatusCall, and whether it refused every one. Nothing is known when
 * that get failed - it does whenever the create did - or the server keeps no
 * delivery status.
 */
export function refusedRecipients(
  answer: [string, Record<string, any>, string] | undefined,
): { recipients: RefusedRecipient[]; all: boolean } {
  const [name, body] = answer ?? [];
  const status = name === 'EmailSubmission/get'
    ? (body?.list?.[0] as { deliveryStatus?: Record<string, { delivered?: string; smtpReply?: string } | null> | null } | undefined)
      ?.deliveryStatus
    : undefined;
  const entries = Object.entries(status ?? {});
  const recipients = entries
    .filter(([, delivery]) => delivery?.delivered === 'no')
    .map(([email, delivery]) => ({ email, ...(delivery?.smtpReply ? { smtpReply: delivery.smtpReply } : {}) }));
  return { recipients, all: recipients.length > 0 && recipients.length === entries.length };
}

export function submissionDestroyCall(ids: string[], accountId: string, callId: string): JMAPMethodCall {
  return ['EmailSubmission/set', { accountId, destroy: ids }, callId];
}

/**
 * The ids an EmailSubmission/set destroy removed. `notFound` means the record
 * is gone already - another device got there first - which is what the
 * caller wanted. Any other failure is only logged: a leftover record costs
 * quota, never mail.
 */
export function readSubmissionDestroy(res: JMAPResponseBody | undefined, callId: string): string[] {
  const [name, body] = res?.methodResponses?.find(([, , id]) => id === callId) ?? [];
  if (name !== 'EmailSubmission/set') {
    console.warn('[submissions] destroy failed:', body);
    return [];
  }
  const failures = Object.entries((body?.notDestroyed ?? {}) as Record<string, SetError>)
    .filter(([, error]) => error?.type !== 'notFound');
  if (failures.length > 0) {
    console.warn('[submissions] not destroyed:', Object.fromEntries(failures));
  }
  return Array.isArray(body?.destroyed) ? (body.destroyed as string[]) : [];
}

/**
 * Destroy EmailSubmission records, in batches the server accepts. Callers
 * must only pass records that can no longer be cancelled.
 *
 * Resolves with the ids the server destroyed. Ids it no longer has count as
 * done; other failures are logged. Never rejects, so no send fails over it.
 */
export async function destroyEmailSubmissions(ids: string[], accountId: string): Promise<string[]> {
  const destroyed: string[] = [];
  for (const slice of batched([...new Set(ids)], jmapClient.getMaxObjectsInSet())) {
    try {
      const res = await jmapClient.request([submissionDestroyCall(slice, accountId, '0')], SUBMISSION_ONLY_USING);
      destroyed.push(...readSubmissionDestroy(res, '0'));
    } catch (err) {
      console.warn('[submissions] destroy failed:', err);
    }
  }
  return destroyed;
}

/**
 * Destroy, in every submission account (submissionAccountIds), the records
 * that can no longer be cancelled (see prunableSubmissionIds). That includes
 * other devices' and other group members' records: the limit is per account.
 * EmailSubmission/query only sees records whose sendAt is at most three days
 * back, so older ones are left to makeRoomForSubmission.
 *
 * Runs at most once per account every ten minutes unless `force` is set.
 * Resolves with the number of records destroyed; never rejects. The app
 * starts it at launch, on returning to the foreground and after sends,
 * without waiting for it.
 */
export async function pruneEmailSubmissions(options: { force?: boolean } = {}): Promise<number> {
  let destroyed = 0;
  try {
    // Without submission there are no records, and a request naming the
    // capability would be refused whole.
    if (!jmapClient.hasCapability(CAPABILITIES.SUBMISSION)) return 0;
    const [primary] = jmapClient.getSubmissionAccountIds();
    for (const accountId of submissionAccountIds()) {
      destroyed += await pruneSubmissionAccount(accountId, options.force ?? false, accountId === primary);
    }
  } catch (err) {
    console.warn('[submissions] prune failed:', err);
  }
  return destroyed;
}

async function pruneSubmissionAccount(accountId: string, force: boolean, primary: boolean): Promise<number> {
  const now = Date.now();
  const key = pruneKey(accountId);
  const lastRun = prunedAt.get(key);
  if (!force && lastRun !== undefined && now - lastRun < PRUNE_INTERVAL_MS) return 0;
  prunedAt.set(key, now);
  try {
    const prunable = await findPrunableSubmissions(accountId, now);
    if (prunable.length === 0) return 0;
    return (await destroyEmailSubmissions(prunable, accountId)).length;
  } catch (err) {
    // Stalwart 0.16 lists an account that shared only an address book or a
    // calendar with the submission capability, then refuses its records
    // ("You are not an owner of account ..."). Nothing of this login's is
    // there, so the account is left alone while the app runs.
    if (jmapErrorType(err) === 'forbidden' && !primary) {
      refusedAccounts.add(refusalKey(accountId));
      debug.log('email', `[submissions] ${accountId} refuses this login's submissions; not asking again`);
      return 0;
    }
    console.warn(`[submissions] pruning ${accountId} failed:`, err);
    return 0;
  }
}

/** The records in the account's change log that can go (see submissionIdsFromChangeLog). */
async function findOlderPrunableSubmissions(accountId: string): Promise<string[]> {
  const ids = await submissionIdsFromChangeLog(accountId);
  const now = Date.now();
  const prunable: string[] = [];
  for (const slice of batched(ids, Math.min(500, jmapClient.getMaxObjectsInGet()))) {
    const res = await jmapClient.request([
      ['EmailSubmission/get', { accountId, ids: slice, properties: ['id', 'sendAt', 'undoStatus'] }, '0'],
    ], SUBMISSION_ONLY_USING);
    prunable.push(...prunableSubmissionIds(submissionList(res, '0'), now));
  }
  return prunable;
}

/**
 * Page through the records the query can see that might go - sendAt passed
 * or canceled, a superset either way - and let EmailSubmission/get decide.
 */
async function findPrunableSubmissions(accountId: string, now: number): Promise<string[]> {
  const pageSize = Math.min(500, jmapClient.getMaxObjectsInGet());
  // A UTCDate in whole seconds, like the sendAt it is compared with.
  const before = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const prunable: string[] = [];
  let position = 0;
  for (let page = 0; page < SUBMISSION_SCAN_MAX_PAGES; page++) {
    const res = await jmapClient.request([
      ['EmailSubmission/query', {
        accountId,
        filter: { operator: 'OR', conditions: [{ before }, { undoStatus: 'canceled' }] },
        position,
        limit: pageSize,
        calculateTotal: true,
      }, '0'],
      ['EmailSubmission/get', {
        accountId,
        '#ids': { resultOf: '0', name: 'EmailSubmission/query', path: '/ids' },
        properties: ['id', 'sendAt', 'undoStatus'],
      }, '1'],
    ], SUBMISSION_ONLY_USING);
    const query = requireMethodResult(res, '0', 'EmailSubmission/query');
    const ids = (query.ids as string[] | undefined) ?? [];
    prunable.push(...prunableSubmissionIds(submissionList(res, '1'), now));
    position += ids.length;
    // `total` only comes back with calculateTotal; without it, a short page
    // is the last one.
    const done = typeof query.total === 'number' ? position >= query.total : ids.length < pageSize;
    if (ids.length === 0 || done) break;
  }
  return prunable;
}

/** The list of an EmailSubmission/get response; throws when the get failed. */
function submissionList(res: JMAPResponseBody, callId: string): SubmissionStatus[] {
  return (requireMethodResult(res, callId, 'EmailSubmission/get').list as SubmissionStatus[] | undefined) ?? [];
}

/**
 * Make room after an EmailSubmission/set create came back overQuota. Prunes
 * the account at once; when that frees nothing, the records taking up the
 * room are older than the query can see (sendAt more than three days back).
 * On Stalwart their ids are still in the change log (the last 10,000 changes
 * by default), and get and destroy by id work at any age, so they are found
 * there and pruned by the same rules. Never rejects: the caller retries the
 * create either way, since another device may have made room meanwhile.
 *
 * At a full quota every attempt ends up here - each send, reschedule and
 * read receipt. When a search found nothing that can go, the account is left
 * alone for five minutes: what is left is pending or out of reach, and
 * looking again at once would cost the prune, the change-log walk and the
 * gets once more for the same answer.
 */
export async function makeRoomForSubmission(accountId: string): Promise<void> {
  const key = pruneKey(accountId);
  const recheckAt = roomRecheckAt.get(key);
  if (recheckAt !== undefined && Date.now() < recheckAt) return;
  const now = Date.now();
  prunedAt.set(key, now);
  let found = 0;
  let freed = 0;
  let complete = true;
  const prune = async (lookUp: () => Promise<string[]>, what: string) => {
    try {
      const prunable = await lookUp();
      found += prunable.length;
      if (prunable.length > 0) freed += (await destroyEmailSubmissions(prunable, accountId)).length;
    } catch (err) {
      complete = false;
      console.warn(`[submissions] looking up ${what} of ${accountId} failed:`, err);
    }
  };
  await prune(() => findPrunableSubmissions(accountId, now), 'recent submissions');
  if (freed === 0 && isStalwartAccount(accountId)) {
    await prune(() => findOlderPrunableSubmissions(accountId), 'older submissions');
  }
  // A failed look-up proves nothing; only an answer of "nothing" counts.
  if (complete && found === 0) roomRecheckAt.set(key, Date.now() + ROOM_RECHECK_MS);
  else roomRecheckAt.delete(key);
}

/**
 * Every submission id still in the account's change log. Stalwart reads
 * sinceState "n" as its initial state and answers with the whole log, a
 * record created and destroyed within it left out, in pages chained through
 * `newState` while `hasMoreChanges` is set.
 */
async function submissionIdsFromChangeLog(accountId: string): Promise<string[]> {
  const ids = new Set<string>();
  let sinceState = 'n';
  for (let page = 0; page < SUBMISSION_SCAN_MAX_PAGES; page++) {
    const res = await jmapClient.request(
      [['EmailSubmission/changes', { accountId, sinceState }, '0']],
      SUBMISSION_ONLY_USING,
    );
    const changes = requireMethodResult(res, '0', 'EmailSubmission/changes');
    for (const id of [...(changes.created ?? []), ...(changes.updated ?? [])] as string[]) ids.add(id);
    for (const id of (changes.destroyed ?? []) as string[]) ids.delete(id);
    const next = changes.newState as string | undefined;
    if (!changes.hasMoreChanges || !next || next === sinceState) break;
    sinceState = next;
  }
  return [...ids];
}
