/**
 * Live calendar checks against a real Stalwart server.
 *
 * Opt-in like live-stalwart.test.ts: skipped unless `BULWARK_LIVE_JMAP` and
 * `BULWARK_LIVE_PASS` are set. `BULWARK_LIVE_USER2` (same password) is the
 * attendee of the invitations and the account that shares a calendar and a
 * mail folder with the first one; without it those checks are skipped.
 *
 *   BULWARK_LIVE_JMAP=http://10.10.10.62:8120 \
 *   BULWARK_LIVE_USER=e2e-tablet-light@example.org \
 *   BULWARK_LIVE_USER2=e2e-tablet-land@example.org \
 *   BULWARK_LIVE_PASS=… npx vitest run src/api/__tests__/live-stalwart-calendar.test.ts
 *
 * Everything it creates carries the run's marker in its title or name and is
 * removed afterwards, also after a failed check. The events lie in 2027, away
 * from anything a person keeps in the account.
 *
 * Verified against stalwartlabs/stalwart:v0.16.27 and v1.0.0.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.TZ = 'Europe/Berlin';
});

import { JMAPClient } from '../jmap-client';
import { CAPABILITIES } from '../types';
import type { Calendar, CalendarEvent, Participant } from '../types';
import {
  createEvent,
  deleteEvents,
  getCalendars,
  getEvents,
  queryEvents,
  isCalendarAccessDenied,
} from '../calendar';
import { useCalendarStore } from '../../stores/calendar-store';
import { useSettingsStore } from '../../stores/settings-store';
import { saveOccurrenceEdit, deleteOccurrence, type SeriesEdit } from '../../lib/recurrence-scope-edit';
import { editorTimesChanged, editorTimesFromEvent, eventTimeFieldsToSave } from '../../lib/event-editor-times';
import { participantFieldsToSave, participantLimitOf, seedAttendees, type Attendee } from '../../lib/calendar-participants';
import { expandRecurringEvents } from '../../lib/recurrence-expansion';
import { getEventStartDate } from '../../lib/calendar-utils';
import { alertsToReminders, calendarDefaultAlerts, defaultAlertIdPrefix, remindersToDefaultAlerts } from '../../lib/calendar-alerts';
import { getEffectiveAlerts } from '../../lib/calendar-alert-scheduler';

const SERVER = process.env.BULWARK_LIVE_JMAP;
const USER = process.env.BULWARK_LIVE_USER ?? 'usera@example.org';
const USER2 = process.env.BULWARK_LIVE_USER2;
const PASS = process.env.BULWARK_LIVE_PASS ?? '';
const live = SERVER && PASS ? describe : describe.skip;
const liveTwo = SERVER && PASS && USER2 ? describe : describe.skip;

const USING = [CAPABILITIES.CORE, CAPABILITIES.CALENDARS];
const MAIL_USING = [CAPABILITIES.CORE, CAPABILITIES.MAIL];
const RUN = `live-cal-${Date.now().toString(36)}`;

let client: JMAPClient;
let other: JMAPClient | null = null;

async function connectSingleton(): Promise<void> {
  const mod = await import('../jmap-client');
  client = new JMAPClient();
  await client.connect(SERVER!, USER, PASS);
  // The singleton is a const binding; copy the connected state onto it.
  (mod.jmapClient as unknown as JMAPClient).restoreSnapshot(client.snapshot());
  useCalendarStore.getState().reset();
}

/** The singleton the api modules use. */
async function singleton(): Promise<JMAPClient> {
  return (await import('../jmap-client')).jmapClient as unknown as JMAPClient;
}

type Response = [string, Record<string, any>, string];

async function raw(c: JMAPClient, calls: [string, Record<string, unknown>, string][], using: string[] = USING): Promise<Response[]> {
  return (await c.request(calls, using)).methodResponses as Response[];
}

/** Stalwart 1.0 advertises JMAP Metadata; 0.16 does not. */
function isStalwart10(): boolean {
  return Object.values(client.currentSession?.accounts ?? {}).some(
    (account) => 'urn:ietf:params:jmap:metadata' in (account.accountCapabilities ?? {}),
  );
}

async function ownCalendarId(): Promise<string> {
  const calendars = await getCalendars();
  const own = calendars.filter((c) => !c.accountId);
  const cal = own.find((c) => c.isDefault) ?? own[0];
  expect(cal, 'the account has a calendar').toBeTruthy();
  return cal.id;
}

const SERIES_RULE = (count: number) => [{ '@type': 'RecurrenceRule', frequency: 'weekly', count }] as CalendarEvent['recurrenceRules'];

function seriesData(title: string, start: string, count: number, extra: Partial<CalendarEvent> = {}): Partial<CalendarEvent> {
  return {
    '@type': 'Event',
    title: `${RUN} ${title}`,
    start,
    duration: 'PT1H',
    timeZone: 'Europe/Berlin',
    recurrenceRules: SERIES_RULE(count),
    ...extra,
  } as Partial<CalendarEvent>;
}

/** Load [after, before] into the store and return the occurrences of `uid`, by start. */
async function loadOccurrences(uid: string, after: string, before: string): Promise<CalendarEvent[]> {
  const store = useCalendarStore.getState();
  await store.fetchCalendars();
  const ids = useCalendarStore.getState().calendars.map((c) => c.id);
  await useCalendarStore.getState().fetchEvents(ids, after, before);
  expect(useCalendarStore.getState().error).toBeNull();
  return useCalendarStore.getState().events
    .filter((e) => e.uid === uid)
    .sort((a, b) => getEventStartDate(a).getTime() - getEventStartDate(b).getTime());
}

const startsOf = (events: CalendarEvent[]) => events.map((e) => getEventStartDate(e).toISOString());

/**
 * What the event editor (EventModal.handleSave) writes for `event` when the
 * user changes its title, moves it by `moveMinutes` or edits the attendees.
 */
function editorSave(
  event: CalendarEvent,
  change: { title?: string; moveMinutes?: number; attendees?: Attendee[] },
  userEmails: string[],
): { updates: Partial<CalendarEvent>; edit: SeriesEdit; sendScheduling: boolean } {
  const times = editorTimesFromEvent(event);
  if (change.moveMinutes) {
    const shift = change.moveMinutes * 60_000;
    times.start = new Date(times.start.getTime() + shift);
    times.end = new Date(times.end.getTime() + shift);
  }
  const attendees = change.attendees ?? seedAttendees(event, userEmails);
  const updates: Partial<CalendarEvent> = {
    title: change.title ?? event.title,
    ...eventTimeFieldsToSave(times, event),
    recurrenceRules: event.recurrenceRules,
  };
  Object.assign(updates, participantFieldsToSave(event, attendees, {
    userEmail: userEmails[0],
    userEmails,
    rescheduled: editorTimesChanged(times, event),
  }));
  for (const key of Object.keys(updates) as (keyof CalendarEvent)[]) {
    if (updates[key] === undefined) delete updates[key];
  }
  return { updates, edit: { attendees, when: times, ruleChanged: false }, sendScheduling: attendees.length > 0 };
}

function storeActions() {
  const s = useCalendarStore.getState();
  return { updateEvent: s.updateEvent, createEvent: s.createEvent, getMasterEvent: s.getMasterEvent, deleteEvent: s.deleteEvent };
}

/** The stored series (with its overrides) of `uid` in the account `c` serves. */
async function seriesByUid(c: JMAPClient, uid: string): Promise<Record<string, any>[]> {
  const res = await raw(c, [
    ['CalendarEvent/query', { accountId: c.accountId, filter: { uid } }, 'q'],
    ['CalendarEvent/get', {
      accountId: c.accountId,
      '#ids': { resultOf: 'q', name: 'CalendarEvent/query', path: '/ids' },
      properties: ['id', 'uid', 'title', 'start', 'status', 'recurrenceRule', 'recurrenceOverrides', 'participants', 'useDefaultAlerts', 'alerts'],
    }, 'g'],
  ]);
  return (res.find((r) => r[2] === 'g')?.[1].list ?? []) as Record<string, any>[];
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

function statusOf(participants: Record<string, Participant> | undefined | null, email: string): string | undefined {
  const p = Object.values(participants ?? {}).find((x) =>
    (x.calendarAddress ?? '').toLowerCase() === `mailto:${email.toLowerCase()}`
    || (x.email ?? '').toLowerCase() === email.toLowerCase());
  return p?.participationStatus;
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

live('live Stalwart calendar', () => {
  let calendarId = '';

  beforeAll(async () => {
    await connectSingleton();
    if (USER2) {
      other = new JMAPClient();
      await other.connect(SERVER!, USER2, PASS);
    }
    calendarId = await ownCalendarId();
  }, 60_000);

  afterAll(async () => {
    useSettingsStore.setState({ calendarTimeZone: 'auto' });
    await removeRunEvents(await singleton()).catch(() => undefined);
    if (other) await removeRunEvents(other).catch(() => undefined);
  }, 60_000);

  describe('a series with overrides in its own time zone (native #89)', () => {
    // Six Mondays at 10:00 in Berlin across the start of summer time on
    // 28 March 2027; the second moved to 14:00 with a title of its own, the
    // fourth excluded.
    let uid = '';
    let id = '';

    beforeAll(async () => {
      const created = await createEvent(seriesData('series', '2027-03-15T10:00:00', 6, {
        recurrenceOverrides: {
          '2027-03-22T10:00:00': { start: '2027-03-22T14:00:00', title: `${RUN} moved` },
          '2027-04-05T10:00:00': { excluded: true },
        } as CalendarEvent['recurrenceOverrides'],
      }), calendarId);
      id = created.id;
      uid = (await getEvents([id]))[0].uid!;
    }, 30_000);

    it('cannot ask 1.0 for overrides and UTC times in one get, which is why the app reads them apart', async () => {
      const [[name, result]] = await raw(client, [['CalendarEvent/get', {
        accountId: client.accountId, ids: [id], properties: ['id', 'utcStart', 'recurrenceOverrides'],
      }, '0']]);
      if (isStalwart10()) {
        expect(name).toBe('error');
        expect(result.type).toBe('invalidArguments');
      } else {
        expect(name).toBe('CalendarEvent/get');
      }
    });

    it('reads the series with its overrides and its UTC times', async () => {
      const [event] = await getEvents([id]);
      expect(event.utcStart).toBe('2027-03-15T09:00:00Z');
      expect(Object.keys(event.recurrenceOverrides ?? {}).sort()).toEqual(['2027-03-22T10:00:00', '2027-04-05T10:00:00']);
      expect(event.recurrenceRules?.[0]?.count).toBe(6);
    });

    it('shows the occurrences on the calendar at their Berlin clock time, moved and excluded ones included', async () => {
      const occurrences = await loadOccurrences(uid, '2027-03-14T00:00:00.000Z', '2027-04-30T00:00:00.000Z');
      expect(startsOf(occurrences)).toEqual([
        '2027-03-15T09:00:00.000Z',
        '2027-03-22T13:00:00.000Z',
        '2027-03-29T08:00:00.000Z',
        '2027-04-12T08:00:00.000Z',
        '2027-04-19T08:00:00.000Z',
      ]);
      expect(occurrences[1].title).toBe(`${RUN} moved`);
      expect(occurrences[2].title).toBe(`${RUN} series`);
    });

    it('expands the same occurrences on the device from the series it reads', async () => {
      const [event] = await getEvents([id]);
      const expanded = expandRecurringEvents([event], '2027-03-14T00:00:00.000Z', '2027-04-30T00:00:00.000Z')
        .sort((a, b) => getEventStartDate(a).getTime() - getEventStartDate(b).getTime());
      expect(startsOf(expanded)).toEqual([
        '2027-03-15T09:00:00.000Z',
        '2027-03-22T13:00:00.000Z',
        '2027-03-29T08:00:00.000Z',
        '2027-04-12T08:00:00.000Z',
        '2027-04-19T08:00:00.000Z',
      ]);
      expect(expanded[1].title).toBe(`${RUN} moved`);
    });

    it('loads the calendar in a time zone the server does not know', async () => {
      // Intl takes "europe/berlin"; Stalwart 1.0 refuses it (0.16 reads it as UTC).
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      useSettingsStore.setState({ calendarTimeZone: 'europe/berlin' });
      try {
        useCalendarStore.getState().reset();
        const occurrences = await loadOccurrences(uid, '2027-03-14T00:00:00.000Z', '2027-04-30T00:00:00.000Z');
        expect(occurrences).toHaveLength(5);
        // Events with a zone of their own keep their times whatever zone the query is in.
        expect(startsOf(occurrences)[0]).toBe('2027-03-15T09:00:00.000Z');
        const refused = warn.mock.calls.some((args) => String(args[0]).includes('does not know the time zone'));
        expect(refused).toBe(isStalwart10());
        // Remembered: the next reads go out in UTC without a refused request first.
        expect((await queryEvents([], '2027-03-14T00:00:00.000Z', '2027-04-30T00:00:00.000Z')).length).toBeGreaterThan(0);
      } finally {
        warn.mockRestore();
        useSettingsStore.setState({ calendarTimeZone: 'auto' });
        useCalendarStore.getState().reset();
      }
    }, 30_000);

    it('loads a week that starts at a midnight the clocks repeat', async () => {
      // Havana turns its clocks back from 01:00 to 00:00 on 7 November 2027;
      // 0.16 refused an expanded query from that midnight.
      useSettingsStore.setState({ calendarTimeZone: 'America/Havana' });
      try {
        useCalendarStore.getState().reset();
        await useCalendarStore.getState().fetchCalendars();
        await useCalendarStore.getState().fetchEvents(
          useCalendarStore.getState().calendars.map((c) => c.id),
          '2027-11-07T04:00:00.000Z',
          '2027-11-14T05:00:00.000Z',
        );
        expect(useCalendarStore.getState().error).toBeNull();
        expect(useCalendarStore.getState().loadedRange).toEqual({
          after: '2027-11-07T04:00:00.000Z', before: '2027-11-14T05:00:00.000Z',
        });
      } finally {
        useSettingsStore.setState({ calendarTimeZone: 'auto' });
        useCalendarStore.getState().reset();
      }
    }, 30_000);
  });

  describe('series edits from an occurrence', () => {
    // Six Mondays from 3 May 2027 at 10:00 in Berlin, no attendees.
    const after = '2027-05-01T00:00:00.000Z';
    const before = '2027-06-30T00:00:00.000Z';
    let uid = '';
    let masterId = '';
    const me = [USER];

    beforeAll(async () => {
      const created = await createEvent(seriesData('edits', '2027-05-03T10:00:00', 6), calendarId);
      masterId = created.id;
      uid = (await getEvents([masterId]))[0].uid!;
    }, 30_000);

    const at = (events: CalendarEvent[], day: string) => events.find((e) => (e.recurrenceId ?? '').startsWith(day));

    it('changes the title of this occurrence only', async () => {
      const occurrences = await loadOccurrences(uid, after, before);
      expect(occurrences).toHaveLength(6);
      const { updates, edit } = editorSave(at(occurrences, '2027-05-10')!, { title: `${RUN} this` }, me);
      expect(await saveOccurrenceEdit('this', { event: at(occurrences, '2027-05-10')!, updates, editor: edit, userEmails: me }, storeActions())).toBe(true);

      const [master] = await seriesByUid(client, uid);
      expect(master.title).toBe(`${RUN} edits`);
      expect(master.recurrenceOverrides?.['2027-05-10T10:00:00']?.title).toBe(`${RUN} this`);
      const after1 = await loadOccurrences(uid, after, before);
      expect(after1.map((e) => e.title)).toEqual([
        `${RUN} edits`, `${RUN} this`, `${RUN} edits`, `${RUN} edits`, `${RUN} edits`, `${RUN} edits`,
      ]);
    }, 30_000);

    it('moves this occurrence only', async () => {
      const occurrences = await loadOccurrences(uid, after, before);
      const { updates, edit } = editorSave(at(occurrences, '2027-05-17')!, { moveMinutes: 120 }, me);
      expect(await saveOccurrenceEdit('this', { event: at(occurrences, '2027-05-17')!, updates, editor: edit, userEmails: me }, storeActions())).toBe(true);
      const moved = await loadOccurrences(uid, after, before);
      expect(startsOf(moved)).toEqual([
        '2027-05-03T08:00:00.000Z', '2027-05-10T08:00:00.000Z', '2027-05-17T10:00:00.000Z',
        '2027-05-24T08:00:00.000Z', '2027-05-31T08:00:00.000Z', '2027-06-07T08:00:00.000Z',
      ]);
    }, 30_000);

    it('deletes this occurrence only', async () => {
      const occurrences = await loadOccurrences(uid, after, before);
      expect(await deleteOccurrence('this', { event: at(occurrences, '2027-05-24')!, userEmails: me }, storeActions())).toBe(true);
      const left = await loadOccurrences(uid, after, before);
      expect(left.map((e) => e.recurrenceId?.slice(0, 10))).toEqual(['2027-05-03', '2027-05-10', '2027-05-17', '2027-05-31', '2027-06-07']);
      const [master] = await seriesByUid(client, uid);
      expect(master.recurrenceOverrides?.['2027-05-24T10:00:00']?.excluded).toBe(true);
    }, 30_000);

    it('splits the series at this and the following occurrences', async () => {
      const occurrences = await loadOccurrences(uid, after, before);
      const { updates, edit } = editorSave(at(occurrences, '2027-05-31')!, { title: `${RUN} following` }, me);
      expect(await saveOccurrenceEdit('this_and_future', {
        event: at(occurrences, '2027-05-31')!, updates, editor: edit, calendarId, userEmails: me,
      }, storeActions())).toBe(true);

      const [old] = await seriesByUid(client, uid);
      expect(old.recurrenceRule?.until).toBeTruthy();
      expect(old.recurrenceRule?.count ?? null).toBeNull();
      const store = useCalendarStore.getState();
      await store.fetchEvents(store.calendars.map((c) => c.id), after, before);
      const rest = useCalendarStore.getState().events
        .filter((e) => e.title === `${RUN} following`)
        .sort((a, b) => getEventStartDate(a).getTime() - getEventStartDate(b).getTime());
      // What was left of the count: two of six.
      expect(startsOf(rest)).toEqual(['2027-05-31T08:00:00.000Z', '2027-06-07T08:00:00.000Z']);
      expect(rest[0].uid).not.toBe(uid);
      const kept = await loadOccurrences(uid, after, before);
      expect(kept.map((e) => e.recurrenceId?.slice(0, 10))).toEqual(['2027-05-03', '2027-05-10', '2027-05-17']);

      // Deleting the rest from its second occurrence on ends it after its first.
      const second = rest[1];
      expect(await deleteOccurrence('this_and_future', { event: second, userEmails: me }, storeActions())).toBe(true);
      const [newSeries] = await seriesByUid(client, rest[0].uid!);
      expect(newSeries.recurrenceRule?.until).toBeTruthy();
      await store.fetchEvents(store.calendars.map((c) => c.id), after, before);
      expect(useCalendarStore.getState().events.filter((e) => e.uid === rest[0].uid)).toHaveLength(1);
    }, 60_000);

    it('changes and moves all occurrences, keeping each one\'s own changes', async () => {
      let occurrences = await loadOccurrences(uid, after, before);
      const rename = editorSave(occurrences[0], { title: `${RUN} all` }, me);
      expect(await saveOccurrenceEdit('all', { event: occurrences[0], updates: rename.updates, editor: rename.edit, userEmails: me }, storeActions())).toBe(true);
      occurrences = await loadOccurrences(uid, after, before);
      expect(occurrences.map((e) => e.title)).toEqual([`${RUN} all`, `${RUN} this`, `${RUN} all`]);

      // An hour later, all of them: the occurrence moved on its own keeps
      // the time the user gave it, the one deleted stays deleted, none is
      // listed twice.
      const move = editorSave(occurrences[0], { moveMinutes: 60 }, me);
      expect(await saveOccurrenceEdit('all', { event: occurrences[0], updates: move.updates, editor: move.edit, userEmails: me }, storeActions())).toBe(true);
      occurrences = await loadOccurrences(uid, after, before);
      expect(startsOf(occurrences)).toEqual(['2027-05-03T09:00:00.000Z', '2027-05-10T09:00:00.000Z', '2027-05-17T10:00:00.000Z']);
      expect(occurrences.map((e) => e.title)).toEqual([`${RUN} all`, `${RUN} this`, `${RUN} all`]);
      const [master] = await seriesByUid(client, uid);
      expect(master.start).toBe('2027-05-03T11:00:00');
      expect(Object.keys(master.recurrenceOverrides ?? {}).sort()).toEqual([
        '2027-05-10T11:00:00', '2027-05-17T11:00:00', '2027-05-24T11:00:00',
      ]);
      expect(master.recurrenceOverrides['2027-05-24T11:00:00'].excluded).toBe(true);
    }, 60_000);

    it('deletes the whole series from an occurrence', async () => {
      const occurrences = await loadOccurrences(uid, after, before);
      expect(await deleteOccurrence('all', { event: occurrences[1], userEmails: me }, storeActions())).toBe(true);
      expect(await seriesByUid(client, uid)).toHaveLength(0);
      expect(await loadOccurrences(uid, after, before)).toHaveLength(0);
    }, 30_000);
  });

  describe('participant limit', () => {
    it('names the server\'s participant limit when 1.0 refuses an event with too many', async () => {
      const participants: Record<string, Participant> = {
        org: { '@type': 'Participant', calendarAddress: `mailto:${USER}`, roles: { owner: true }, participationStatus: 'accepted' } as Participant,
      };
      for (let i = 0; i < 20; i++) {
        participants[`a${i}`] = { '@type': 'Participant', calendarAddress: `mailto:guest${i}@example.net`, roles: { attendee: true } } as Participant;
      }
      const event = {
        '@type': 'Event', title: `${RUN} crowd`, start: '2027-07-05T10:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin',
        participants, organizerCalendarAddress: `mailto:${USER}`,
      } as Partial<CalendarEvent>;
      let error: unknown = null;
      try {
        const created = await createEvent(event, calendarId, false);
        await deleteEvents([created.id], false);
      } catch (err) {
        error = err;
      }
      if (isStalwart10()) {
        expect(participantLimitOf(error)).toBe(20);
      } else {
        expect(error).toBeNull();
      }
    }, 30_000);
  });

  describe('default alerts', () => {
    let calendar: Calendar | undefined;
    let before: Record<string, unknown> | null = null;

    beforeAll(async () => {
      calendar = (await getCalendars()).find((c) => c.id === calendarId);
      before = (calendar?.defaultAlertsWithTime as Record<string, unknown> | null | undefined) ?? null;
      await raw(client, [['Calendar/set', {
        accountId: client.accountId,
        update: { [calendarId]: { defaultAlertsWithTime: { d1: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' } } } } },
      }, '0']]);
    }, 30_000);

    afterAll(async () => {
      await raw(client, [['Calendar/set', {
        accountId: client.accountId, update: { [calendarId]: { defaultAlertsWithTime: before } },
      }, '0']]).catch(() => undefined);
    }, 30_000);

    it('keeps the reminder changed on one occurrence of a series on the calendar\'s default reminders', async () => {
      const created = await createEvent(seriesData('alerts', '2027-08-02T10:00:00', 3, { useDefaultAlerts: true }), calendarId);
      const uid = (await getEvents([created.id]))[0].uid!;
      const occurrences = await loadOccurrences(uid, '2027-08-01T00:00:00.000Z', '2027-08-31T00:00:00.000Z');
      expect(occurrences).toHaveLength(3);
      const own = { a1: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT1H' } } };
      await useCalendarStore.getState().updateEvent(occurrences[1].id, { useDefaultAlerts: false, alerts: own } as Partial<CalendarEvent>);
      const [master] = await seriesByUid(client, uid);
      expect(master.useDefaultAlerts).toBe(false);
      const reloaded = await loadOccurrences(uid, '2027-08-01T00:00:00.000Z', '2027-08-31T00:00:00.000Z');
      const offsets = (e: CalendarEvent) => Object.values(e.alerts ?? {}).map((a) => (a.trigger as { offset?: string }).offset).sort();
      expect(offsets(reloaded[1])).toEqual(['-PT1H']);
      // The others keep the reminder the calendar gave them.
      expect(offsets(reloaded[0])).toEqual(['-PT15M']);
    }, 60_000);
  });

  liveTwo('invitations', () => {
    const after = '2027-09-01T00:00:00.000Z';
    const before = '2027-09-30T00:00:00.000Z';
    let uid = '';
    const me = [USER];

    it('keeps the attendee\'s answer on a change and asks again when the organizer moves it', async () => {
      // Four Mondays from 6 September 2027, the second user invited.
      const invitation = editorSave(
        { title: `${RUN} meeting`, start: '2027-09-06T10:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin' } as CalendarEvent,
        { attendees: [{ name: 'Land', email: USER2! }] },
        me,
      );
      const created = await useCalendarStore.getState().createEvent({
        ...seriesData('meeting', '2027-09-06T10:00:00', 4),
        participants: invitation.updates.participants,
        organizerCalendarAddress: invitation.updates.organizerCalendarAddress,
      }, calendarId, { sendSchedulingMessages: true });
      uid = created.uid!;

      // The attendee's copy arrives through the server's own scheduling.
      const copies = await waitFor(() => seriesByUid(other!, uid), (list) => list.length > 0);
      expect(copies, 'the invitation reached the second user').toHaveLength(1);
      const copy = copies[0];
      const myId = Object.entries(copy.participants ?? {}).find(([, p]) =>
        String((p as Participant).calendarAddress).toLowerCase() === `mailto:${USER2!.toLowerCase()}`)?.[0];
      expect(myId).toBeTruthy();
      await raw(other!, [['CalendarEvent/set', {
        accountId: other!.accountId,
        update: { [copy.id]: { [`participants/${myId}/participationStatus`]: 'accepted' } },
        sendSchedulingMessages: true,
      }, '0']]);
      let [mine] = await waitFor(() => seriesByUid(client, uid), (list) => statusOf(list[0]?.participants, USER2!) === 'accepted');
      expect(statusOf(mine.participants, USER2!)).toBe('accepted');

      // The attendee declines the third occurrence alone, in the app.
      (await singleton()).restoreSnapshot(other!.snapshot());
      try {
        useCalendarStore.getState().reset();
        const theirs = await loadOccurrences(uid, after, before);
        const third = theirs.find((e) => (e.recurrenceId ?? '').startsWith('2027-09-20'))!;
        const participantId = Object.entries(third.participants ?? {}).find(([, p]) =>
          String(p.calendarAddress).toLowerCase() === `mailto:${USER2!.toLowerCase()}`)![0];
        await useCalendarStore.getState().rsvpEvent(third.id, participantId, 'declined', null, undefined, 'occurrence');
      } finally {
        await connectSingleton();
      }
      [mine] = await waitFor(() => seriesByUid(client, uid), (list) => {
        const entry = list[0]?.recurrenceOverrides?.['2027-09-20T10:00:00'] as Record<string, any> | undefined;
        return !!entry && JSON.stringify(entry).includes('declined');
      });
      expect(JSON.stringify(mine.recurrenceOverrides?.['2027-09-20T10:00:00'] ?? null)).toContain('declined');
      expect(statusOf(mine.participants, USER2!)).toBe('accepted');

      // A new title for all: the answer stays.
      let occurrences = await loadOccurrences(uid, after, before);
      const rename = editorSave(occurrences[0], { title: `${RUN} meeting renamed` }, me);
      expect(await saveOccurrenceEdit('all', {
        event: occurrences[0], updates: rename.updates, editor: rename.edit, sendScheduling: rename.sendScheduling, userEmails: me,
      }, storeActions())).toBe(true);
      [mine] = await seriesByUid(client, uid);
      expect(mine.title).toBe(`${RUN} meeting renamed`);
      expect(statusOf(mine.participants, USER2!)).toBe('accepted');
      expect(JSON.stringify(mine.recurrenceOverrides?.['2027-09-20T10:00:00'] ?? null)).toContain('declined');
      const renamed = await waitFor(() => seriesByUid(other!, uid), (list) => list[0]?.title === `${RUN} meeting renamed`);
      expect(statusOf(renamed[0].participants, USER2!)).toBe('accepted');

      // One occurrence an hour later: asked again for that one alone.
      occurrences = await loadOccurrences(uid, after, before);
      const moveOne = editorSave(occurrences[1], { moveMinutes: 60 }, me);
      expect(await saveOccurrenceEdit('this', {
        event: occurrences[1], updates: moveOne.updates, editor: moveOne.edit, sendScheduling: moveOne.sendScheduling, userEmails: me,
      }, storeActions())).toBe(true);
      [mine] = await seriesByUid(client, uid);
      const override = mine.recurrenceOverrides?.['2027-09-13T10:00:00'] as Record<string, any> | undefined;
      expect(override?.start).toBe('2027-09-13T11:00:00');
      const overrideStatus = override?.participants
        ? statusOf(override.participants, USER2!)
        : Object.entries(override ?? {}).find(([k]) => k.endsWith('/participationStatus'))?.[1];
      expect(overrideStatus).toBe('needs-action');
      expect(statusOf(mine.participants, USER2!)).toBe('accepted');

      // All of them an hour later: asked again for the series.
      occurrences = await loadOccurrences(uid, after, before);
      const moveAll = editorSave(occurrences[0], { moveMinutes: 60 }, me);
      expect(await saveOccurrenceEdit('all', {
        event: occurrences[0], updates: moveAll.updates, editor: moveAll.edit, sendScheduling: moveAll.sendScheduling, userEmails: me,
      }, storeActions())).toBe(true);
      [mine] = await seriesByUid(client, uid);
      expect(mine.start).toBe('2027-09-06T11:00:00');
      expect(statusOf(mine.participants, USER2!)).toBe('needs-action');

      // Cancelled for the attendee too.
      occurrences = await loadOccurrences(uid, after, before);
      expect(await deleteOccurrence('all', { event: occurrences[0], userEmails: me }, storeActions())).toBe(true);
      const gone = await waitFor(() => seriesByUid(other!, uid), (list) => list.length === 0 || list[0]?.status === 'cancelled');
      expect(gone.length === 0 || gone[0].status === 'cancelled').toBe(true);
    }, 120_000);
  });

  liveTwo('shares', () => {
    let mailboxId = '';
    let sharedCalendarId = '';
    let principal = '';

    afterAll(async () => {
      if (!other) return;
      if (sharedCalendarId) {
        await raw(other, [['Calendar/set', { accountId: other.accountId, destroy: [sharedCalendarId], onDestroyRemoveEvents: true }, '0']]).catch(() => undefined);
      }
      if (mailboxId) {
        await raw(other, [['Mailbox/set', { accountId: other.accountId, destroy: [mailboxId], onDestroyRemoveEmails: true }, '0']], MAIL_USING).catch(() => undefined);
      }
      await connectSingleton().catch(() => undefined);
    }, 60_000);

    it('asks an account that shares only mail for its calendars once, without an error', async () => {
      principal = client.accountId;
      const [[, created]] = await raw(other!, [['Mailbox/set', {
        accountId: other!.accountId,
        create: { m: { name: `${RUN} shared`, shareWith: { [principal]: { mayReadItems: true } } } },
      }, '0']], [...MAIL_USING, 'urn:ietf:params:jmap:principals']);
      mailboxId = created.created?.m?.id ?? '';
      expect(mailboxId, JSON.stringify(created.notCreated)).toBeTruthy();

      await connectSingleton();
      const sharer = other!.accountId;
      expect(client.currentSession?.accounts?.[sharer], 'the sharer\'s account is in the session').toBeTruthy();
      // What the server answers there: 0.16 forbidden, 1.0 accountNotSupportedByMethod.
      const [[name, answer]] = await raw(client, [['Calendar/get', { accountId: sharer, ids: [] }, '0']]);
      expect(name).toBe('error');
      expect(['forbidden', 'accountNotSupportedByMethod', 'accountNotFound']).toContain(answer.type);
      const jmap = await singleton();
      const spy = vi.spyOn(jmap, 'request');
      try {
        const store = useCalendarStore.getState();
        for (let i = 0; i < 3; i++) {
          await store.fetchCalendars();
          await useCalendarStore.getState().fetchEvents(useCalendarStore.getState().calendars.map((c) => c.id),
            '2027-09-01T00:00:00.000Z', '2027-09-30T00:00:00.000Z');
          await useCalendarStore.getState().fetchTasks();
        }
        expect(useCalendarStore.getState().error).toBeNull();
        const toSharer = spy.mock.calls.filter(([calls]) =>
          (calls as unknown as [string, Record<string, unknown>][]).some(([, args]) => args.accountId === sharer));
        // Both servers list the account for calendars: the one probe, then
        // no retry on every load.
        expect(client.currentSession?.accounts?.[sharer]?.accountCapabilities?.[CAPABILITIES.CALENDARS], 'the session lists the sharer for calendars').toBeTruthy();
        expect(toSharer).toHaveLength(1);
        expect(isCalendarAccessDenied(sharer)).toBe(true);
      } finally {
        spy.mockRestore();
      }
    }, 60_000);

    it('shows a calendar another account shares and writes its events there', async () => {
      const [[, created]] = await raw(other!, [['Calendar/set', {
        accountId: other!.accountId,
        create: { c: { name: `${RUN} team`, shareWith: { [principal]: { mayReadItems: true, mayWriteAll: true, mayWriteOwn: true, mayUpdatePrivate: true, mayRSVP: true, mayReadFreeBusy: true } } } },
      }, '0']], [...USING, 'urn:ietf:params:jmap:principals']);
      sharedCalendarId = created.created?.c?.id ?? '';
      expect(sharedCalendarId, JSON.stringify(created.notCreated)).toBeTruthy();
      const [[, made]] = await raw(other!, [['CalendarEvent/set', {
        accountId: other!.accountId,
        create: { e: { ...seriesData('owner series', '2027-10-04T10:00:00', 2), recurrenceRule: SERIES_RULE(2)![0], recurrenceRules: undefined, calendarIds: { [sharedCalendarId]: true } } },
      }, '0']]);
      expect(made.created?.e?.id, JSON.stringify(made.notCreated)).toBeTruthy();

      await connectSingleton();
      const store = useCalendarStore.getState();
      await store.fetchCalendars();
      const shared = useCalendarStore.getState().calendars.find((c) => c.name === `${RUN} team`);
      expect(shared?.accountId).toBe(other!.accountId);
      // The month as the app asks for it: from local midnight to local midnight.
      await useCalendarStore.getState().fetchEvents(useCalendarStore.getState().calendars.map((c) => c.id),
        '2027-09-30T22:00:00.000Z', '2027-10-30T22:00:00.000Z');
      const theirs = useCalendarStore.getState().events
        .filter((e) => e.title === `${RUN} owner series`)
        .sort((a, b) => getEventStartDate(a).getTime() - getEventStartDate(b).getTime());
      expect(theirs).toHaveLength(2);
      expect(theirs.every((e) => e.accountId === other!.accountId && !!e.calendarIds?.[shared!.id])).toBe(true);

      // An edit of one of its occurrences goes to the owner's account.
      const { updates, edit } = editorSave(theirs[1], { title: `${RUN} owner second` }, [USER]);
      expect(await saveOccurrenceEdit('this', { event: theirs[1], updates, editor: edit, userEmails: [USER] }, storeActions())).toBe(true);
      const list = (await raw(other!, [['CalendarEvent/query', { accountId: other!.accountId, filter: { inCalendar: sharedCalendarId } }, 'q'],
        ['CalendarEvent/get', { accountId: other!.accountId, '#ids': { resultOf: 'q', name: 'CalendarEvent/query', path: '/ids' }, properties: ['id', 'recurrenceOverrides'] }, 'g']]))
        .find((r) => r[2] === 'g')?.[1].list as Record<string, any>[];
      expect(list).toHaveLength(1);
      expect(list[0].recurrenceOverrides?.['2027-10-11T10:00:00']?.title).toBe(`${RUN} owner second`);
    }, 60_000);
  });

  describe('a calendar\'s default reminders (#1209)', () => {
    let defaultsCalendarId = '';
    let otherCalendarId = '';

    afterAll(async () => {
      const ids = [defaultsCalendarId, otherCalendarId].filter(Boolean);
      if (ids.length > 0) {
        await raw(client, [['Calendar/set', { accountId: client.accountId, destroy: ids, onDestroyRemoveEvents: true }, '0']]).catch(() => undefined);
      }
    }, 30_000);

    it('are set and cleared in the calendar and given to a new event that uses them', async () => {
      await connectSingleton();
      const [[, made]] = await raw(client, [['Calendar/set', {
        accountId: client.accountId, create: { c: { name: `${RUN} defaults`, color: '#3b82f6' } },
      }, '0']]);
      defaultsCalendarId = made.created?.c?.id ?? '';
      expect(defaultsCalendarId, JSON.stringify(made.notCreated)).toBeTruthy();
      await useCalendarStore.getState().fetchCalendars();

      // As the calendar editor saves them.
      // Another calendar of the account with defaults under the plain ids
      // the editor wrote before: 1.0 wants them unique in the account.
      const plain = await raw(client, [['Calendar/set', {
        accountId: client.accountId,
        create: { o: { name: `${RUN} other defaults`, defaultAlertsWithTime: remindersToDefaultAlerts([{ minutesBefore: 5 }]) } },
      }, '0']]);
      otherCalendarId = plain[0][1].created?.o?.id ?? '';
      const target = { id: defaultsCalendarId };
      await useCalendarStore.getState().updateCalendar(defaultsCalendarId, {
        defaultAlertsWithTime: remindersToDefaultAlerts([{ minutesBefore: 15 }], {}, defaultAlertIdPrefix(target, false)),
        defaultAlertsWithoutTime: remindersToDefaultAlerts([{ minutesBefore: 60 * 24 }], {}, defaultAlertIdPrefix(target, true)),
      });
      await useCalendarStore.getState().fetchCalendars();
      const cal = useCalendarStore.getState().calendars.find((c) => c.id === defaultsCalendarId)!;
      expect(alertsToReminders(calendarDefaultAlerts(cal, false))).toEqual([{ minutesBefore: 15 }]);
      expect(alertsToReminders(calendarDefaultAlerts(cal, true))).toEqual([{ minutesBefore: 60 * 24 }]);

      // As the event editor creates an event on the defaults.
      const created = await useCalendarStore.getState().createEvent({
        '@type': 'Event', title: `${RUN} on defaults`, start: '2027-12-03T09:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin', useDefaultAlerts: true,
      } as Partial<CalendarEvent>, defaultsCalendarId);
      const [stored] = await getEvents([created.id]);
      expect(stored.useDefaultAlerts).toBe(true);
      const effective = getEffectiveAlerts(stored, useCalendarStore.getState().calendars) ?? {};
      expect(alertsToReminders(effective)).toEqual([{ minutesBefore: 15 }]);

      // Emptied.
      await useCalendarStore.getState().updateCalendar(defaultsCalendarId, { defaultAlertsWithTime: remindersToDefaultAlerts([]) });
      const [[, after]] = await raw(client, [['Calendar/get', { accountId: client.accountId, ids: [defaultsCalendarId], properties: ['defaultAlertsWithTime'] }, '0']]);
      expect(Object.keys(after.list[0].defaultAlertsWithTime ?? {})).toEqual([]);
    }, 60_000);
  });

  describe('a zero-length event (#837)', () => {
    it('ends at its start, stored without a duration or imported from an .ics', async () => {
      await connectSingleton();
      // As another client stores it: no duration at all.
      const [[, made]] = await raw(client, [['CalendarEvent/set', {
        accountId: client.accountId,
        create: { z: { '@type': 'Event', title: `${RUN} zero`, start: '2027-12-01T09:00:00', timeZone: 'Europe/Berlin', calendarIds: { [calendarId]: true } } },
      }, '0']]);
      const id = made.created?.z?.id;
      expect(id, JSON.stringify(made.notCreated)).toBeTruthy();
      const [read] = await getEvents([id]);
      expect(read.utcStart).toBe('2027-12-01T08:00:00Z');
      expect(read.utcEnd).toBe(read.utcStart);

      // An .ics whose DTEND equals its DTSTART, imported.
      const uid = `${RUN}-zero-import`;
      await useCalendarStore.getState().fetchCalendars();
      const { imported } = await useCalendarStore.getState().importEvents([
        { uid, title: `${RUN} zero imported`, start: '2027-12-02T09:00:00', timeZone: 'Europe/Berlin' },
      ], calendarId);
      expect(imported).toBe(1);
      const [stored] = await seriesByUid(client, uid);
      const [[, got]] = await raw(client, [['CalendarEvent/get', { accountId: client.accountId, ids: [stored.id], properties: ['duration', 'utcStart', 'utcEnd'] }, '0']]);
      expect(got.list[0].utcEnd).toBe(got.list[0].utcStart);
    }, 60_000);
  });

  describe('a subscribed feed', () => {
    const FEED_URL = 'https://feeds.invalid/live.ics';
    let feed = '';
    const realFetch = globalThis.fetch;

    const vevent = (uid: string, title: string, start: string, extra = '') =>
      `BEGIN:VEVENT\r\nUID:${RUN}-${uid}\r\nDTSTAMP:20271101T000000Z\r\nDTSTART:${start}\r\nDURATION:PT1H\r\nSUMMARY:${RUN} ${title}\r\n${extra}END:VEVENT\r\n`;
    const calendar = (...events: string[]) =>
      `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//live//EN\r\n${events.join('')}END:VCALENDAR\r\n`;

    async function mirrorEvents(calendarId: string): Promise<Record<string, any>[]> {
      const res = await raw(client, [
        ['CalendarEvent/query', { accountId: client.accountId, filter: { inCalendar: calendarId } }, 'q'],
        ['CalendarEvent/get', {
          accountId: client.accountId,
          '#ids': { resultOf: 'q', name: 'CalendarEvent/query', path: '/ids' },
          properties: ['id', 'uid', 'title', 'start', 'locations', 'recurrenceRule'],
        }, 'g'],
      ]);
      return (res.find((r) => r[2] === 'g')?.[1].list ?? []) as Record<string, any>[];
    }

    beforeAll(() => {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) !== FEED_URL) return realFetch(input, init);
        return new Response(feed, { status: 200, headers: { 'Content-Type': 'text/calendar' } });
      }) as typeof fetch;
    });

    afterAll(async () => {
      globalThis.fetch = realFetch;
      const { useCalendarSubscriptionsStore } = await import('../../stores/calendar-subscriptions-store');
      for (const sub of useCalendarSubscriptionsStore.getState().subscriptions) {
        if (sub.calendarId && sub.name.includes(RUN)) {
          await raw(client, [['Calendar/set', { accountId: client.accountId, destroy: [sub.calendarId], onDestroyRemoveEvents: true }, '0']]).catch(() => undefined);
        }
      }
      useCalendarSubscriptionsStore.setState({ subscriptions: [] });
    }, 60_000);

    it('gives the events it still carries what it changed, drops what it left out and writes nothing when unchanged', async () => {
      await connectSingleton();
      const { useCalendarSubscriptionsStore } = await import('../../stores/calendar-subscriptions-store');
      const subs = useCalendarSubscriptionsStore.getState();
      feed = calendar(
        vevent('a', 'talk', '20271206T090000Z', 'LOCATION:Room 1\r\n'),
        vevent('b', 'workshop', '20271207T090000Z'),
        vevent('w', 'weekly', '20271208T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=3\r\n'),
      );
      const sub = await subs.addSubscription({ name: `${RUN} feed`, url: FEED_URL });
      expect(sub.calendarId).toBeTruthy();
      const first = await mirrorEvents(sub.calendarId!);
      expect(first.map((e) => e.title).sort()).toEqual([`${RUN} talk`, `${RUN} weekly`, `${RUN} workshop`]);
      const talkId = first.find((e) => e.uid === `${RUN}-a`)!.id;

      // Unchanged: no write at all.
      const jmap = await singleton();
      const spy = vi.spyOn(jmap, 'request');
      try {
        await useCalendarSubscriptionsStore.getState().syncSubscription(sub.id);
        const writes = spy.mock.calls.filter(([calls]) =>
          (calls as unknown as [string, Record<string, unknown>][]).some(([name, args]) =>
            name === 'CalendarEvent/set' && (args.update || args.destroy || args.create)));
        expect(writes).toEqual([]);
      } finally {
        spy.mockRestore();
      }
      expect(useCalendarSubscriptionsStore.getState().subscriptions.find((s) => s.id === sub.id)?.lastError).toBeNull();

      // Moved, renamed and in another room; one gone, one new, the series longer.
      feed = calendar(
        vevent('a', 'talk moved', '20271206T110000Z', 'LOCATION:Room 2\r\n'),
        vevent('c', 'new talk', '20271209T090000Z'),
        vevent('w', 'weekly', '20271208T090000Z', 'RRULE:FREQ=WEEKLY;COUNT=5\r\n'),
      );
      await useCalendarSubscriptionsStore.getState().syncSubscription(sub.id);
      expect(useCalendarSubscriptionsStore.getState().subscriptions.find((s) => s.id === sub.id)?.lastError).toBeNull();
      const second = await mirrorEvents(sub.calendarId!);
      expect(second.map((e) => e.title).sort()).toEqual([`${RUN} new talk`, `${RUN} talk moved`, `${RUN} weekly`]);
      const talk = second.find((e) => e.uid === `${RUN}-a`)!;
      // The same event, changed in place.
      expect(talk.id).toBe(talkId);
      expect((await getEvents([talk.id]))[0].utcStart).toBe('2027-12-06T11:00:00Z');
      expect(Object.values(talk.locations ?? {}).map((l: any) => l.name)).toEqual(['Room 2']);
      const weekly = second.find((e) => e.uid === `${RUN}-w`)!;
      const rule = Array.isArray(weekly.recurrenceRule) ? weekly.recurrenceRule[0] : weekly.recurrenceRule;
      expect(rule?.count).toBe(5);

      await useCalendarSubscriptionsStore.getState().removeSubscription(sub.id);
      const [[, gone]] = await raw(client, [['Calendar/get', { accountId: client.accountId, ids: [sub.calendarId] }, '0']]);
      expect(gone.notFound).toEqual([sub.calendarId]);
    }, 90_000);
  });

  describe('tasks', () => {
    it('lists the account\'s own tasks and none of another account\'s', async () => {
      const [[, created]] = await raw(client, [['CalendarEvent/set', {
        accountId: client.accountId,
        create: { t: { '@type': 'Task', title: `${RUN} task`, calendarIds: { [calendarId]: true }, due: '2027-11-01T10:00:00', timeZone: 'Europe/Berlin' } },
      }, '0']]);
      expect(created.created?.t?.id, JSON.stringify(created.notCreated)).toBeTruthy();
      useCalendarStore.getState().reset();
      await useCalendarStore.getState().fetchCalendars();
      await useCalendarStore.getState().fetchTasks();
      expect(useCalendarStore.getState().tasks.map((t) => t.title)).toContain(`${RUN} task`);

      if (!USER2 || !other) return;
      const theirCalendar = (await raw(other, [['Calendar/get', { accountId: other.accountId, properties: ['id', 'isDefault'] }, '0']]))[0][1]
        .list.find((c: { isDefault?: boolean }) => c.isDefault)?.id;
      const [[, theirs]] = await raw(other, [['CalendarEvent/set', {
        accountId: other.accountId,
        create: { t: { '@type': 'Task', title: `${RUN} their task`, calendarIds: { [theirCalendar]: true }, due: '2027-11-02T10:00:00', timeZone: 'Europe/Berlin' } },
      }, '0']]);
      expect(theirs.created?.t?.id, JSON.stringify(theirs.notCreated)).toBeTruthy();

      // The first account's task load is still waiting for its tasks when
      // the client switches to the second account and loads that one's.
      const second = new JMAPClient();
      await second.connect(SERVER!, USER2, PASS);
      const jmap = await singleton();
      const request = jmap.request.bind(jmap);
      let switched = false;
      let waiting = false;
      let release!: () => void;
      const answers = new Promise<void>((resolve) => { release = resolve; });
      const spy = vi.spyOn(jmap, 'request').mockImplementation(async (calls, using) => {
        const readsTasks = (calls as unknown as [string, Record<string, unknown>][]).some(([name, args]) =>
          name === 'CalendarEvent/get' && Array.isArray(args.properties) && args.properties.includes('alerts'));
        if (switched || !readsTasks) return request(calls, using);
        // Sent by the first account before the switch, answered after it.
        waiting = true;
        await answers;
        return client.request(calls, using);
      });
      try {
        useCalendarStore.getState().reset();
        const outgoing = useCalendarStore.getState().fetchTasks();
        await waitFor(async () => waiting, (w) => w, 10_000);
        expect(waiting, 'the first account\'s tasks are being read').toBe(true);

        switched = true;
        jmap.restoreSnapshot(second.snapshot());
        useCalendarStore.getState().reset();
        await useCalendarStore.getState().fetchCalendars();
        await useCalendarStore.getState().fetchTasks();
        const loaded = useCalendarStore.getState().tasks;
        expect(loaded.map((t) => t.title)).toContain(`${RUN} their task`);
        release();
        await outgoing;

        // Untouched by the first account's load, which reads its task ids in
        // the second account by then: the e2e accounts repeat each other's
        // ids, so what that finds can even look right.
        expect(useCalendarStore.getState().tasks).toBe(loaded);
        expect(loaded.map((t) => t.title)).not.toContain(`${RUN} task`);
      } finally {
        release();
        spy.mockRestore();
        await connectSingleton();
      }
    }, 60_000);
  });
});
