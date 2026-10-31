/**
 * Live CalendarEventNotification checks against a real Stalwart.
 *
 * Opt-in like live-stalwart-calendar.test.ts: skipped unless
 * `BULWARK_LIVE_JMAP`, `BULWARK_LIVE_PASS` and `BULWARK_LIVE_USER2` (same
 * password) are set. The second account invites the first one to an event in
 * 2027 and then cancels it; the first one reads the notifications the server
 * keeps for that and acknowledges them. Only the notifications of this run
 * are destroyed, and the event carries the run's marker and is removed from
 * both accounts afterwards.
 *
 *   BULWARK_LIVE_JMAP=http://10.10.10.62:8016 \
 *   BULWARK_LIVE_USER=e2e-perf@example.org \
 *   BULWARK_LIVE_USER2=e2e-tablet-land@example.org \
 *   BULWARK_LIVE_PASS=… npx vitest run src/api/__tests__/live-stalwart-event-notifications.test.ts
 *
 * Verified against Stalwart 0.16.27 and 1.0.1.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { JMAPClient } from '../jmap-client';
import { CAPABILITIES } from '../types';
import {
  destroyCalendarEventNotifications,
  getCalendarEventNotifications,
  type CalendarEventNotification,
} from '../calendar-event-notifications';
import { eventNotificationToast } from '../../lib/calendar-event-notifications';

const SERVER = process.env.BULWARK_LIVE_JMAP;
const USER = process.env.BULWARK_LIVE_USER ?? 'usera@example.org';
const USER2 = process.env.BULWARK_LIVE_USER2;
const PASS = process.env.BULWARK_LIVE_PASS ?? '';
const liveTwo = SERVER && PASS && USER2 ? describe : describe.skip;

const USING = [CAPABILITIES.CORE, CAPABILITIES.CALENDARS];
const RUN = `live-cen-${Date.now().toString(36)}`;

type Response = [string, Record<string, any>, string];

async function raw(c: JMAPClient, calls: [string, Record<string, unknown>, string][]): Promise<Response[]> {
  return (await c.request(calls, USING)).methodResponses as Response[];
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  let value = await read();
  while (!done(value) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    value = await read();
  }
  return value;
}

/** Destroy every event of `c`'s account whose title carries the run's marker. */
async function removeRunEvents(c: JMAPClient): Promise<void> {
  const res = await raw(c, [
    ['CalendarEvent/query', { accountId: c.accountId }, 'q'],
    ['CalendarEvent/get', {
      accountId: c.accountId,
      '#ids': { resultOf: 'q', name: 'CalendarEvent/query', path: '/ids' },
      properties: ['id', 'title'],
    }, 'g'],
  ]);
  const ids = ((res.find((r) => r[2] === 'g')?.[1].list ?? []) as { id: string; title?: string }[])
    .filter((e) => e.title?.includes(RUN))
    .map((e) => e.id);
  if (ids.length > 0) {
    await raw(c, [['CalendarEvent/set', { accountId: c.accountId, destroy: ids, sendSchedulingMessages: false }, 'd']]);
  }
}

const t = (_key: string, fallback?: string, params?: Record<string, string | number>) =>
  (fallback ?? '').replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''));

liveTwo('live Stalwart calendar event notifications', () => {
  let other: JMAPClient;
  let before = new Set<string>();
  const ours = new Set<string>();
  let organizerEventId = '';
  let attendeeEventId = '';

  const fresh = async (): Promise<CalendarEventNotification[]> =>
    (await getCalendarEventNotifications()).filter((n) => !before.has(n.id));

  beforeAll(async () => {
    const mod = await import('../jmap-client');
    const client = new JMAPClient();
    await client.connect(SERVER!, USER, PASS);
    (mod.jmapClient as unknown as JMAPClient).restoreSnapshot(client.snapshot());
    other = new JMAPClient();
    await other.connect(SERVER!, USER2!, PASS);
    // Whatever is pending already belongs to someone else's run.
    before = new Set((await getCalendarEventNotifications()).map((n) => n.id));
  }, 60_000);

  afterAll(async () => {
    const leftover = (await getCalendarEventNotifications().catch(() => []))
      .filter((n) => ours.has(n.id) || (!before.has(n.id) && n.event?.title?.includes(RUN)));
    await destroyCalendarEventNotifications(leftover.map((n) => n.id)).catch(() => undefined);
    await removeRunEvents(other).catch(() => undefined);
    const mod = await import('../jmap-client');
    await removeRunEvents(mod.jmapClient as unknown as JMAPClient).catch(() => undefined);
  }, 60_000);

  it('lists the invitation another account sent, with who sent it and the event’s title', async () => {
    const cals = await raw(other, [['Calendar/get', { accountId: other.accountId, properties: ['id', 'isDefault'] }, '0']]);
    const list = cals[0][1].list as { id: string; isDefault?: boolean }[];
    const calendarId = (list.find((c) => c.isDefault) ?? list[0]).id;
    const created = await raw(other, [['CalendarEvent/set', {
      accountId: other.accountId,
      create: {
        inv: {
          '@type': 'Event',
          title: `${RUN} review`,
          calendarIds: { [calendarId]: true },
          start: '2027-06-08T10:00:00',
          timeZone: 'Europe/Berlin',
          duration: 'PT1H',
          organizerCalendarAddress: `mailto:${USER2}`,
          participants: {
            org: {
              '@type': 'Participant', calendarAddress: `mailto:${USER2}`, email: USER2,
              roles: { owner: true, attendee: true }, participationStatus: 'accepted', kind: 'individual',
            },
            att: {
              '@type': 'Participant', calendarAddress: `mailto:${USER}`, email: USER,
              roles: { attendee: true }, participationStatus: 'needs-action', expectReply: true, kind: 'individual',
            },
          },
        },
      },
      sendSchedulingMessages: true,
    }, '0']]);
    organizerEventId = created[0][1].created?.inv?.id ?? '';
    expect(organizerEventId, JSON.stringify(created[0][1].notCreated)).toBeTruthy();

    const notes = await waitFor(fresh, (l) => l.some((n) => n.type === 'created'));
    const invite = notes.find((n) => n.type === 'created');
    expect(invite, JSON.stringify(notes)).toBeTruthy();
    ours.add(invite!.id);
    attendeeEventId = invite!.calendarEventId;
    expect(invite!.changedBy?.email?.toLowerCase()).toBe(USER2!.toLowerCase());
    expect(invite!.isDraft).toBe(false);
    // 1.0 returns the event with the notification; 0.16 doesn't, and the
    // title is read from the attendee's copy instead.
    expect(invite!.event?.title).toBe(`${RUN} review`);
    expect(eventNotificationToast(invite!, t)!.title).toContain(`invited you to "${RUN} review"`);
  });

  it('lists the cancellation, and forgets both once acknowledged', async () => {
    expect(organizerEventId).toBeTruthy();
    await raw(other, [['CalendarEvent/set', {
      accountId: other.accountId,
      destroy: [organizerEventId],
      sendSchedulingMessages: true,
    }, '0']]);
    const notes = await waitFor(fresh, (l) => l.some((n) => n.type === 'destroyed' || (n.type === 'updated' && n.calendarEventId === attendeeEventId && !ours.has(n.id))));
    const cancel = notes.find((n) => n.calendarEventId === attendeeEventId && !ours.has(n.id));
    expect(cancel, JSON.stringify(notes)).toBeTruthy();
    ours.add(cancel!.id);
    // Both servers send it as an update that sets the status to cancelled
    // (the attendee's copy stays, cancelled); it must read as a cancellation.
    const toast = eventNotificationToast(cancel!, t)!;
    expect(toast.type, JSON.stringify(cancel)).toBe('warning');
    expect(toast.title).toContain(`cancelled "${RUN} review"`);

    await destroyCalendarEventNotifications([...ours]);
    const after = (await getCalendarEventNotifications()).map((n) => n.id);
    for (const id of ours) expect(after).not.toContain(id);
    // Nobody else's notifications went with them.
    for (const id of before) expect(after).toContain(id);
  });
});
