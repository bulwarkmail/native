import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import type { BusyPeriod } from './types';
import { availabilityFor, mergeBusyBlocks } from '../lib/availability';
import type { AvailabilityStatus, BusyBlock } from '../lib/availability';

export interface AvailabilityQuery {
  /** JMAP account the request is made in, passed explicitly (never read from the client). */
  accountId: string;
  principalId: string;
  start: Date;
  end: Date;
  /** Connection the caller started on; the request is refused if it was replaced. */
  gen?: number;
}

const wireTime = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Whether the server can answer free/busy queries. */
export function supportsAvailability(): boolean {
  return jmapClient.hasCapability(CAPABILITIES.PRINCIPALS) && jmapClient.hasCapability(CAPABILITIES.PRINCIPALS_AVAILABILITY);
}

/**
 * Busy periods of a principal (Principal/getAvailability). Event details are
 * never requested. Throws on any failure: callers show "unknown".
 */
export async function getPrincipalAvailability(q: AvailabilityQuery): Promise<BusyPeriod[]> {
  if (!supportsAvailability()) throw new Error('Availability is not supported');
  const res = await jmapClient.request(
    [['Principal/getAvailability', {
      accountId: q.accountId,
      id: q.principalId,
      utcStart: wireTime(q.start),
      utcEnd: wireTime(q.end),
      showDetails: false,
    }, '0']],
    [CAPABILITIES.CORE, CAPABILITIES.PRINCIPALS, CAPABILITIES.PRINCIPALS_AVAILABILITY],
    q.gen === undefined ? undefined : { gen: q.gen },
  );
  const [method, result] = res.methodResponses?.[0] ?? [];
  if (method !== 'Principal/getAvailability') {
    throw new Error((result as { description?: string } | undefined)?.description || 'Failed to query availability');
  }
  const list = ((result as { list?: Array<Partial<BusyPeriod>> }).list ?? []);
  return list.map((p) => ({ utcStart: p.utcStart as string, utcEnd: p.utcEnd as string, busyStatus: p.busyStatus ?? null }));
}

type FetchOne = (principalId: string, range: { start: Date; end: Date }) => Promise<BusyPeriod[]>;

/**
 * Remembers each answer for the life of the editor: one request per
 * participant and range, shared by concurrent callers. A failed request is
 * remembered too (null, shown as unknown) rather than retried on every edit.
 */
export function createAvailabilityLoader(fetchOne: FetchOne) {
  const cache = new Map<string, Promise<BusyPeriod[] | null>>();
  return {
    load(principalId: string, range: { start: Date; end: Date }): Promise<BusyPeriod[] | null> {
      const key = `${principalId}|${range.start.getTime()}|${range.end.getTime()}`;
      let hit = cache.get(key);
      if (!hit) {
        hit = fetchOne(principalId, range).catch(() => null);
        cache.set(key, hit);
      }
      return hit;
    },
  };
}

/**
 * Status of each attendee over the event window. Only attendees with a
 * principal id are asked about; anyone else, and any failure, is unknown.
 */
export async function loadAttendeeAvailability(opts: {
  emails: string[];
  principalIdByEmail: ReadonlyMap<string, string>;
  range: { start: Date; end: Date };
  window: { start: Date; end: Date };
  loader: ReturnType<typeof createAvailabilityLoader>;
}): Promise<Record<string, { status: AvailabilityStatus; blocks: BusyBlock[] }>> {
  const entries = await Promise.all(opts.emails.map(async (email) => {
    const id = opts.principalIdByEmail.get(email);
    if (!id) return [email, { status: 'unknown' as const, blocks: [] }] as const;
    const periods = await opts.loader.load(id, opts.range);
    if (!periods) return [email, { status: 'unknown' as const, blocks: [] }] as const;
    return [email, {
      status: availabilityFor(periods, opts.window.start, opts.window.end),
      blocks: mergeBusyBlocks(periods, opts.window.start, opts.window.end),
    }] as const;
  }));
  return Object.fromEntries(entries);
}
