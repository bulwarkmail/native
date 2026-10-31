/**
 * Live free/busy checks (Principal/getAvailability) against a real Stalwart.
 *
 * Opt-in like live-stalwart-calendar.test.ts: skipped unless
 * `BULWARK_LIVE_JMAP`, `BULWARK_LIVE_PASS` and `BULWARK_LIVE_USER2` (same
 * password) are set. The second account gets a busy event in 2027, which the
 * first one looks up the way the event editor does; the event carries the
 * run's marker and is removed afterwards.
 *
 *   BULWARK_LIVE_JMAP=http://10.10.10.62:8016 \
 *   BULWARK_LIVE_USER=e2e-perf@example.org \
 *   BULWARK_LIVE_USER2=e2e-tablet-land@example.org \
 *   BULWARK_LIVE_PASS=… npx vitest run src/api/__tests__/live-stalwart-free-busy.test.ts
 *
 * Verified against Stalwart 0.16.27 and 1.0.1.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { JMAPClient } from '../jmap-client';
import { CAPABILITIES } from '../types';
import {
  checkAvailabilityAccess,
  loadPrincipalDirectory,
  lookUpAvailabilityStatuses,
  resetAvailabilityCaches,
  supportsAvailability,
} from '../calendar-availability';

const SERVER = process.env.BULWARK_LIVE_JMAP;
const USER = process.env.BULWARK_LIVE_USER ?? 'usera@example.org';
const USER2 = process.env.BULWARK_LIVE_USER2;
const PASS = process.env.BULWARK_LIVE_PASS ?? '';
const liveTwo = SERVER && PASS && USER2 ? describe : describe.skip;

const USING = [CAPABILITIES.CORE, CAPABILITIES.CALENDARS];
const RUN = `live-fb-${Date.now().toString(36)}`;

type Response = [string, Record<string, any>, string];

async function raw(c: JMAPClient, calls: [string, Record<string, unknown>, string][]): Promise<Response[]> {
  return (await c.request(calls, USING)).methodResponses as Response[];
}

/** Stalwart 1.0 advertises JMAP Metadata; 0.16 does not. */
function isStalwart10(c: JMAPClient): boolean {
  return Object.values(c.currentSession?.accounts ?? {}).some(
    (account) => 'urn:ietf:params:jmap:metadata' in (account.accountCapabilities ?? {}),
  );
}

liveTwo('live Stalwart free/busy', () => {
  let other: JMAPClient;
  let client: JMAPClient;
  const busyIds: string[] = [];
  let sharedCalendarId = '';

  async function addBusy(calendarId: string, start: string): Promise<void> {
    const created = await raw(other, [['CalendarEvent/set', {
      accountId: other.accountId,
      create: {
        busy: {
          '@type': 'Event',
          title: `${RUN} busy`,
          calendarIds: { [calendarId]: true },
          start,
          timeZone: 'UTC',
          duration: 'PT1H',
          freeBusyStatus: 'busy',
        },
      },
    }, '0']]);
    const id = created[0][1].created?.busy?.id;
    expect(id, JSON.stringify(created[0][1].notCreated)).toBeTruthy();
    busyIds.push(id);
  }

  beforeAll(async () => {
    const mod = await import('../jmap-client');
    client = new JMAPClient();
    await client.connect(SERVER!, USER, PASS);
    (mod.jmapClient as unknown as JMAPClient).restoreSnapshot(client.snapshot());
    resetAvailabilityCaches();

    other = new JMAPClient();
    await other.connect(SERVER!, USER2!, PASS);
    const cals = await raw(other, [['Calendar/get', { accountId: other.accountId, properties: ['id', 'isDefault'] }, '0']]);
    const list = cals[0][1].list as { id: string; isDefault?: boolean }[];
    // A busy hour in the default calendar, which shares nothing.
    await addBusy((list.find((c) => c.isDefault) ?? list[0]).id, '2027-04-14T10:00:00');
    if (!isStalwart10(client)) {
      // And one in a calendar of its own that lets the first account see
      // free/busy, which is what 0.16 asks before it answers.
      const found = await other.request([['Principal/query', { accountId: other.accountId, filter: { email: USER } }, '0']],
        [CAPABILITIES.CORE, CAPABILITIES.PRINCIPALS]);
      const me = (found.methodResponses[0][1].ids as string[])[0];
      const made = await raw(other, [['Calendar/set', {
        accountId: other.accountId,
        create: { fb: { name: `${RUN} free/busy`, shareWith: { [me]: { mayReadFreeBusy: true } } } },
      }, '0']]);
      sharedCalendarId = made[0][1].created?.fb?.id ?? '';
      expect(sharedCalendarId, JSON.stringify(made[0][1].notCreated)).toBeTruthy();
      await addBusy(sharedCalendarId, '2027-04-15T10:00:00');
    }
  }, 60_000);

  afterAll(async () => {
    if (busyIds.length > 0) {
      await raw(other, [['CalendarEvent/set', { accountId: other.accountId, destroy: busyIds }, '0']]).catch(() => undefined);
    }
    if (sharedCalendarId) {
      await raw(other, [['Calendar/set', { accountId: other.accountId, destroy: [sharedCalendarId], onDestroyRemoveEvents: true }, '0']])
        .catch(() => undefined);
    }
  }, 60_000);

  it('is advertised by the server', () => {
    expect(supportsAvailability()).toBe(true);
  });

  it('says free/busy is not available on 1.0 with directory queries off, without looking anyone up', async () => {
    if (!isStalwart10(client)) return;
    // 1.0 keeps directory queries off by default: no address can be
    // matched to a principal, and the editor says so in one line.
    const directory = await loadPrincipalDirectory();
    expect(directory.status).toBe('restricted');
    expect(directory.directoryQueriesOff).toBe(true);
    expect(await lookUpAvailabilityStatuses(
      [USER2!.toLowerCase()],
      new Date('2027-04-14T10:30:00Z'),
      new Date('2027-04-14T11:30:00Z'),
    )).toBeNull();
  });

  it('shows no busy times for someone whose calendars share no free/busy (0.16)', async () => {
    if (isStalwart10(client)) return;
    expect(await checkAvailabilityAccess()).toBe(true);
    expect(await lookUpAvailabilityStatuses(
      [USER2!.toLowerCase()],
      new Date('2027-04-14T10:30:00Z'),
      new Date('2027-04-14T11:30:00Z'),
    )).toEqual({ [USER2!.toLowerCase()]: 'no_busy_times' });
  });

  it('shows the attendee busy during a shared busy hour and free next to it (0.16)', async () => {
    if (isStalwart10(client)) return;
    expect(await lookUpAvailabilityStatuses(
      [USER2!.toLowerCase()],
      new Date('2027-04-15T10:30:00Z'),
      new Date('2027-04-15T11:30:00Z'),
    )).toEqual({ [USER2!.toLowerCase()]: 'busy' });
    expect(await lookUpAvailabilityStatuses(
      [USER2!.toLowerCase(), 'nobody@elsewhere.invalid'],
      new Date('2027-04-15T12:00:00Z'),
      new Date('2027-04-15T13:00:00Z'),
    )).toEqual({ [USER2!.toLowerCase()]: 'free', 'nobody@elsewhere.invalid': 'unknown' });
  });
});
