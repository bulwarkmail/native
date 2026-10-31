import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import type { Principal } from './types';
import { batched } from './jmap-result';
import { listPrincipals, type PrincipalListing } from './files';
import {
  availabilityWindow,
  statusFromAnswer,
  type AvailabilityStatus,
  type BusyPeriod,
  type PrincipalAvailability,
} from '../lib/calendar-free-busy';

// Free/busy (Principal/getAvailability) lookups for the event editor. Ported
// from the webmail's lib/jmap/free-busy.ts, lib/jmap/principal-directory.ts,
// the availability methods of lib/jmap/client.ts and lookUpStatuses in
// components/calendar/participant-availability.tsx.
//
// Whether the server answers free/busy for this user at all is asked once
// per session. Stalwart 1.0 says so on the user's own principal
// (`mayGetAvailability`), and refuses to list its directory while the
// administrator keeps directory queries off (its default): without the
// directory no address can be matched to a principal, so the editor says
// free/busy isn't available. Busy periods are cached per principal and window
// for a few minutes: the editor looks everyone up again whenever the time or
// the attendees change, and Stalwart 1.0 allows 100 getAvailability calls per
// account a minute, counting every call however they are batched.

export const PRINCIPALS_AVAILABILITY_CAPABILITY = 'urn:ietf:params:jmap:principals:availability';
export const AVAILABILITY_TTL_MS = 3 * 60 * 1000;
/**
 * Stalwart counts availability calls in fixed one-minute windows and refuses
 * every call until the window is over, without saying when that is. A full
 * minute after a refusal is always past it.
 */
export const RATE_LIMIT_BACKOFF_MS = 60 * 1000;
export const PRINCIPAL_DIRECTORY_TTL_MS = 5 * 60 * 1000;

function principalsUsing(): string[] {
  return [CAPABILITIES.CORE, CAPABILITIES.PRINCIPALS];
}

function availabilityUsing(): string[] {
  return [...principalsUsing(), PRINCIPALS_AVAILABILITY_CAPABILITY];
}

/** The session the caches belong to: another account or server starts over. */
function sessionKey(): string {
  return `${jmapClient.currentSession?.apiUrl ?? ''}|${jmapClient.accountId}`;
}

/** Whether the server can answer free/busy queries for its principals. */
export function supportsAvailability(): boolean {
  return jmapClient.hasCapability(CAPABILITIES.PRINCIPALS)
    && jmapClient.hasCapability(PRINCIPALS_AVAILABILITY_CAPABILITY);
}

/**
 * Whether this user may ask for other people's free/busy, from the user's
 * own principal: Stalwart 1.0 sets `capabilities[calendars].mayGetAvailability`
 * to false when it won't answer. 0.16 leaves that object empty, which means
 * go ahead. A `forbidden` answer (a role without the principal permissions)
 * means no as well; other failures throw.
 */
export async function mayGetAvailability(): Promise<boolean> {
  if (!supportsAvailability()) return false;
  const accountId = jmapClient.accountId;
  const principals = jmapClient.getAccountCapability(CAPABILITIES.PRINCIPALS, accountId) as
    { currentUserPrincipalId?: string | null } | undefined;
  const ownId = principals?.currentUserPrincipalId || accountId;
  const response = await jmapClient.request(
    [['Principal/get', { accountId, ids: [ownId], properties: ['id', 'capabilities'] }, '0']],
    principalsUsing(),
  );
  const [method, result] = response.methodResponses?.[0] ?? [];
  if (method !== 'Principal/get') {
    if (result?.type === 'forbidden') return false;
    throw new Error(result?.description || "Failed to read the user's principal");
  }
  const own = ((result?.list ?? []) as Array<{ id: string; capabilities?: Record<string, unknown> }>)
    .find((p) => p.id === ownId);
  const calendars = own?.capabilities?.[CAPABILITIES.CALENDARS] as { mayGetAvailability?: boolean } | undefined;
  return calendars?.mayGetAvailability !== false;
}

/** The busy periods of a Principal/getAvailability response. */
function busyPeriodsOf(result: { list?: unknown } | undefined): BusyPeriod[] {
  const list = (result?.list ?? []) as Array<{ utcStart: string; utcEnd: string; busyStatus?: BusyPeriod['busyStatus'] }>;
  return list.map((p) => ({ utcStart: p.utcStart, utcEnd: p.utcEnd, busyStatus: p.busyStatus ?? null }));
}

function availabilityArgs(principalId: string, utcStart: Date, utcEnd: Date): Record<string, unknown> {
  return {
    accountId: jmapClient.accountId,
    id: principalId,
    utcStart: utcStart.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    utcEnd: utcEnd.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    // Only whether someone is free, never what they are doing.
    showDetails: false,
  };
}

/**
 * The busy periods of several principals over one window, batched into as
 * few requests as maxCallsInRequest allows: Principal/getAvailability takes
 * a single id. Each principal gets its periods, or the error type its call
 * was refused with. A failed request throws.
 */
export async function getPrincipalsAvailability(
  principalIds: string[],
  utcStart: Date,
  utcEnd: Date,
): Promise<Record<string, PrincipalAvailability>> {
  const results: Record<string, PrincipalAvailability> = {};
  if (!supportsAvailability()) return results;
  for (const batch of batched(principalIds, jmapClient.getMaxCallsInRequest())) {
    const response = await jmapClient.request(
      batch.map((id, i): [string, Record<string, unknown>, string] => [
        'Principal/getAvailability', availabilityArgs(id, utcStart, utcEnd), String(i),
      ]),
      availabilityUsing(),
    );
    const byCallId = new Map(((response.methodResponses ?? []) as [string, any, string][]).map((r) => [r[2], r]));
    batch.forEach((id, i) => {
      const [method, result] = byCallId.get(String(i)) ?? [];
      results[id] = method === 'Principal/getAvailability'
        ? { periods: busyPeriodsOf(result) }
        : { error: (result as { type?: string } | undefined)?.type || 'serverFail' };
    });
  }
  return results;
}

// ── Access check, once per session ───────────────────────────────

const access = new Map<string, boolean>();
const pendingChecks = new Map<string, Promise<boolean>>();

/** What an earlier check learned, or undefined when nothing has been asked yet. */
export function knownAvailabilityAccess(): boolean | undefined {
  return access.get(sessionKey());
}

/** Asks the server once per session whether free/busy lookups are allowed. Never rejects. */
export function checkAvailabilityAccess(): Promise<boolean> {
  const key = sessionKey();
  const known = access.get(key);
  if (known !== undefined) return Promise.resolve(known);
  let check = pendingChecks.get(key);
  if (!check) {
    check = mayGetAvailability()
      .then((allowed) => {
        access.set(key, allowed);
        return allowed;
      })
      // A failed check proves nothing either way: look up this time and ask
      // again next time.
      .catch(() => true)
      .finally(() => pendingChecks.delete(key));
    pendingChecks.set(key, check);
  }
  return check;
}

/** The server refused a lookup outright; stop asking in this session. */
export function revokeAvailabilityAccess(): void {
  access.set(sessionKey(), false);
}

// ── Principal directory, shared while fresh ──────────────────────

const directories = new Map<string, { loadedAt: number; listing: Promise<PrincipalListing> }>();

/**
 * The server's principal listing, shared while it is fresh; callers that
 * arrive while it loads get the same request. Never rejects.
 */
export function loadPrincipalDirectory(): Promise<PrincipalListing> {
  const key = sessionKey();
  const cached = directories.get(key);
  if (cached && Date.now() - cached.loadedAt < PRINCIPAL_DIRECTORY_TTL_MS) return cached.listing;
  const listing = listPrincipals().catch((): PrincipalListing => ({ principals: [], status: 'error' }));
  const entry = { loadedAt: Date.now(), listing };
  directories.set(key, entry);
  void listing.then(({ status }) => {
    // A failed listing isn't kept, so the next caller asks again.
    if (status === 'error' && directories.get(key) === entry) directories.delete(key);
  });
  return listing;
}

// ── Cached lookups ───────────────────────────────────────────────

interface CachedLookup {
  requestedAt: number;
  result: Promise<PrincipalAvailability>;
}

interface LookupState {
  cache: Map<string, CachedLookup>;
  backoffUntil: number;
}

const lookups = new Map<string, LookupState>();

function lookupState(): LookupState {
  const key = sessionKey();
  let state = lookups.get(key);
  if (!state) {
    state = { cache: new Map(), backoffUntil: 0 };
    lookups.set(key, state);
  }
  return state;
}

/**
 * The busy periods of each principal over the local days from `start` to
 * `end`, for the caller to match against the exact event window. Fresh
 * answers come from the cache, lookups already on their way are shared, and
 * the rest go out as one batched request. Never rejects: a failed request
 * counts as `serverUnavailable`, and while the server is rate limiting, the
 * answer is `rateLimit` without asking.
 */
export async function lookUpAvailability(
  principalIds: string[],
  start: Date,
  end: Date,
): Promise<Record<string, PrincipalAvailability>> {
  const state = lookupState();
  const { cache } = state;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.requestedAt >= AVAILABILITY_TTL_MS) cache.delete(key);
  }

  const days = availabilityWindow(start, end);
  const keyOf = (id: string) => `${id}|${days.start.getTime()}|${days.end.getTime()}`;
  const results = new Map<string, Promise<PrincipalAvailability>>();
  const missing: string[] = [];
  for (const id of new Set(principalIds)) {
    const cached = cache.get(keyOf(id));
    if (cached) results.set(id, cached.result);
    else missing.push(id);
  }

  if (missing.length > 0 && now < state.backoffUntil) {
    for (const id of missing) results.set(id, Promise.resolve({ error: 'rateLimit' }));
  } else if (missing.length > 0) {
    const batch = getPrincipalsAvailability(missing, days.start, days.end)
      .catch((): Record<string, PrincipalAvailability> => ({}));
    for (const id of missing) {
      const key = keyOf(id);
      const entry: CachedLookup = {
        requestedAt: now,
        result: batch.then((answers) => answers[id] ?? { error: 'serverUnavailable' }),
      };
      cache.set(key, entry);
      results.set(id, entry.result);
      void entry.result.then((result) => {
        if (!('error' in result)) return;
        // Only answers are kept: a refused lookup is asked again next time.
        if (cache.get(key) === entry) cache.delete(key);
        if (result.error === 'rateLimit') {
          state.backoffUntil = Math.max(state.backoffUntil, Date.now() + RATE_LIMIT_BACKOFF_MS);
        }
      });
    }
  }

  const settled = await Promise.all([...results].map(async ([id, result]) => [id, await result] as const));
  return Object.fromEntries(settled);
}

/**
 * The status of every address for the window, or null when the server won't
 * answer free/busy for this user: Stalwart 1.0 with directory queries off,
 * or a lookup refused with `forbidden`.
 */
export async function lookUpAvailabilityStatuses(
  emails: string[],
  start: Date,
  end: Date,
): Promise<Record<string, AvailabilityStatus> | null> {
  const directory = await loadPrincipalDirectory();
  // With directory queries off, Stalwart 1.0 can't match an address to a
  // principal. Any other refused listing is a role without the permission
  // to list principals, which is not the one for free/busy: the principals
  // Principal/get still returned are looked up, and a lookup refused in turn
  // says it.
  if (directory.status === 'restricted' && directory.directoryQueriesOff) return null;
  const byEmail = new Map<string, Principal>();
  for (const p of directory.principals) {
    if (p.email) byEmail.set(p.email.toLowerCase(), p);
  }
  const principalIds = emails.flatMap((email) => byEmail.get(email)?.id ?? []);
  const answers = await lookUpAvailability(principalIds, start, end);
  const statuses: Record<string, AvailabilityStatus> = {};
  for (const email of emails) {
    const principal = byEmail.get(email);
    if (!principal) {
      // Only a complete listing shows that an address is not a user here.
      statuses[email] = directory.status === 'ok' ? 'unknown' : 'error';
      continue;
    }
    const answer = answers[principal.id];
    if ('error' in answer) {
      if (answer.error === 'forbidden') return null;
      statuses[email] = 'error';
    } else {
      statuses[email] = statusFromAnswer(answer.periods, start, end);
    }
  }
  return statuses;
}

/** Forget every cached answer (tests, sign-out). */
export function resetAvailabilityCaches(): void {
  access.clear();
  pendingChecks.clear();
  directories.clear();
  lookups.clear();
}
