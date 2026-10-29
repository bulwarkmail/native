/**
 * Test harness for the calendar planner: the fake CalendarProvider, a
 * CalendarContext over a few server calendars, and helpers that plan, apply
 * the op groups the way the engine does and read the rows back.
 */
import { expect } from 'vitest';
import { FakeDeviceProviders } from '../fakes/fake-provider';
import { CALENDAR_AUTHORITY, type ProviderPort, type Row } from '../../types';
import type { CalendarContext, LocalCalendar, LocalEvent, OpGroup } from '../../planner';
import type { CalendarEventWire, CalendarLike } from '../../wire';
import { calendarPlanner } from '../../calendar/planner';
import { applyPatch, type PatchObject } from '../../common/patch';
import { makeKeyMinter, parseCollectionKey, uuidFrom } from '../../common/ids';
import { Events } from '../../android-columns';

export const ACCOUNT = 'usera@example.org';
export const ME = 'usera@example.org';
export const ALIAS = 'alias@example.org';
export const ACCT = 'c';

export function seeded(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
}

export const CALENDARS: Record<string, CalendarLike> = {
  b: {
    id: 'b',
    name: 'Personal',
    color: '#3b82f6',
    myRights: { mayReadItems: true, mayWriteAll: true, mayWriteOwn: true, mayRSVP: true, mayDelete: true },
    defaultAlertsWithTime: { d1: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT10M' }, action: 'display' } },
    defaultAlertsWithoutTime: { d2: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT15H' }, action: 'display' } },
  } as CalendarLike,
  w: { id: 'w', name: 'Work', color: '#22c55e', myRights: { mayReadItems: true, mayWriteAll: true, mayWriteOwn: true, mayRSVP: true } } as CalendarLike,
  r: { id: 'r', name: 'Team (read)', myRights: { mayReadItems: true, mayRSVP: true } } as CalendarLike,
};

export interface HarnessOptions {
  deviceZone?: string;
  reminderOwner?: 'device' | 'bulwark';
  readOnly?: string[];
  now?: number;
}

export class Harness {
  readonly fake = new FakeDeviceProviders();
  readonly port: ProviderPort = this.fake.port(ACCOUNT, CALENDAR_AUTHORITY);
  readonly rowIds = new Map<string, number>();
  ctx: CalendarContext;

  constructor(options: HarnessOptions = {}) {
    const random = seeded(7);
    const readOnly = new Set(options.readOnly ?? ['r']);
    this.ctx = {
      jmapAccountId: ACCT,
      now: options.now ?? Date.parse('2026-09-27T12:00:00Z'),
      mintKey: makeKeyMinter(random),
      mintUid: () => uuidFrom(random),
      deviceZone: options.deviceZone ?? 'Europe/Berlin',
      ownerAccount: ME,
      selfAddresses: [ME, ALIAS],
      reminderOwner: options.reminderOwner ?? 'device',
      calendar: (id) => CALENDARS[id],
      calendarRowId: (id) => this.rowIds.get(id) ?? null,
      calendarIdOfRow: (rowId) => {
        for (const [id, row] of this.rowIds) if (row === rowId) return { jmapAccountId: ACCT, calendarId: id };
        return null;
      },
      isReadOnly: (id) => readOnly.has(id),
      isSelected: (key) => parseCollectionKey(key)?.accountId === ACCT,
    };
  }

  /** Inserts the calendar rows through planCalendars. */
  async setup(ids: string[] = ['b', 'w', 'r']): Promise<this> {
    const plan = calendarPlanner.planCalendars(
      ids.map((id) => ({ jmapAccountId: ACCT, calendar: CALENDARS[id], readOnly: this.ctx.isReadOnly(id), accountName: ME })),
      [],
      this.ctx,
    );
    for (const group of plan.groups) await this.apply(group);
    for (const cal of await this.calendars()) this.rowIds.set(parseCollectionKey(cal.syncId)!.id, cal.calendarRowId);
    return this;
  }

  /** Applies a group and the groups after it (`next`), each in a batch of its own, as the engine does. */
  async apply(group: OpGroup): Promise<void> {
    for (const g of [group, ...(group.next ?? [])]) {
      const result = await this.port.applyBatch(g.ops);
      if (!result.ok) throw new Error(`batch ${group.ref} failed: ${result.reason} ${result.message}`);
    }
  }

  async tryApply(group: OpGroup) {
    return this.port.applyBatch(group.ops);
  }

  async query(table: 'events' | 'attendees' | 'reminders' | 'calendars', columns: readonly string[]): Promise<Row[]> {
    const res = await this.port.query({ table, columns: [...columns] });
    return res.rows.map((cells) => Object.fromEntries(res.columns.map((c, i) => [c, cells[i]])));
  }

  async calendars(): Promise<LocalCalendar[]> {
    return (await this.query('calendars', calendarPlanner.calendarColumns)).map(calendarPlanner.decodeCalendar);
  }

  async events(): Promise<LocalEvent[]> {
    return calendarPlanner.decodeEvents(
      await this.query('events', calendarPlanner.eventColumns),
      await this.query('attendees', calendarPlanner.attendeeColumns),
      await this.query('reminders', calendarPlanner.reminderColumns),
    );
  }

  /** The local event with this server id (or null). */
  async local(id: string): Promise<LocalEvent | null> {
    return (await this.events()).find((e) => e.syncId === `${ACCT}/${id}`) ?? null;
  }

  async byRow(eventId: number): Promise<LocalEvent> {
    const all = await this.events();
    const found = all.find((e) => e.eventId === eventId);
    if (!found) throw new Error(`no event row ${eventId}`);
    return found;
  }

  /** Plans and applies a download of `event`, then heals baselines like the engine's read-back. */
  async download(event: CalendarEventWire) {
    const local = await this.local(event.id);
    const plan = calendarPlanner.planDownload(event, local, this.ctx);
    if (plan.effect !== 'none') await this.apply(plan.ops);
    await this.heal(event.id);
    return plan;
  }

  async heal(id: string): Promise<void> {
    const local = await this.local(id);
    if (!local) return;
    const heal = calendarPlanner.planBaselineHeal(local);
    if (heal) await this.apply(heal);
  }

  row(eventId: number): Row {
    return this.fake.row('events', eventId)!;
  }

  masterRow(id: string): Row {
    const rows = this.fake.rows('events', `${Events._SYNC_ID} = ?`, [`${ACCT}/${id}`]);
    expect(rows).toHaveLength(1);
    return rows[0];
  }
}

/** The server applying an accepted patch (Stalwart's normalisation of what matters here). */
export function serverApply(event: CalendarEventWire, patch: PatchObject): CalendarEventWire {
  const next = applyPatch(event, patch);
  if (!next) throw new Error(`patch does not apply: ${JSON.stringify(patch)}`);
  const overrides = next.recurrenceOverrides;
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (!value || typeof value !== 'object') continue;
      if ((value as Record<string, unknown>).excluded === true) {
        overrides[key] = { excluded: true };
        continue;
      }
      for (const forbidden of ['@type', 'method', 'organizerCalendarAddress', 'privacy', 'prodId', 'recurrenceId', 'recurrenceIdTimeZone', 'sentBy', 'uid', 'recurrenceRule', 'recurrenceOverrides']) {
        delete (value as Record<string, unknown>)[forbidden];
      }
      // An override is stored as its own VEVENT: an empty map writes nothing, so it reads back without it.
      for (const map of ['participants', 'alerts', 'locations']) {
        const inner = (value as Record<string, unknown>)[map];
        if (inner && typeof inner === 'object' && !Object.keys(inner).length) delete (value as Record<string, unknown>)[map];
      }
    }
    if (!Object.keys(overrides).length) delete next.recurrenceOverrides;
  }
  for (const map of ['participants', 'alerts', 'locations'] as const) {
    if (next[map] && !Object.keys(next[map] as object).length) delete next[map];
  }
  return next;
}

/** The probe's weekly event as Stalwart returned it (scratchpad/probe/calendar.out.txt). */
export function weekly(): CalendarEventWire {
  return {
    id: 'bl',
    '@type': 'Event',
    uid: 'probe-rec@example.org',
    calendarIds: { b: true },
    title: 'Probe weekly',
    description: 'desc',
    start: '2026-10-05T09:00:00',
    timeZone: 'America/New_York',
    duration: 'PT1H30M',
    status: 'tentative',
    freeBusyStatus: 'free',
    privacy: 'private',
    color: 'steelblue',
    keywords: { probe: true },
    priority: 5,
    recurrenceRule: { frequency: 'weekly', count: 10, firstDayOfWeek: 'mo', byDay: [{ day: 'mo' }, { day: 'we' }] },
    recurrenceOverrides: {
      '2026-10-12T09:00:00': { excluded: true },
      '2026-10-07T09:00:00': { updated: '2026-09-26T22:57:38Z', title: 'Moved Wednesday', start: '2026-10-07T11:00:00' },
    },
    locations: { locA: { name: 'Room 1', '@type': 'Location' } },
    participants: {
      me1: { calendarAddress: 'mailto:usera@example.org', '@type': 'Participant', participationStatus: 'accepted', roles: { owner: true, attendee: true } },
      guestX: { calendarAddress: 'mailto:guest@example.net', '@type': 'Participant', participationStatus: 'needs-action', name: 'Guest', expectReply: true, roles: { attendee: true } },
    },
    organizerCalendarAddress: 'mailto:usera@example.org',
    alerts: {
      al1: { action: 'display', '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M', relativeTo: 'start' } },
      alEnd: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: 'PT5M', relativeTo: 'end' } },
      alAbs: { '@type': 'Alert', action: 'email', trigger: { '@type': 'AbsoluteTrigger', when: '2026-10-01T08:00:00Z' } },
    },
    updated: '2026-09-26T22:57:38Z',
    isDraft: false,
  } as CalendarEventWire;
}

export function single(extra: Partial<CalendarEventWire> = {}): CalendarEventWire {
  return {
    id: 'e1',
    '@type': 'Event',
    uid: 'single-1@example.org',
    calendarIds: { b: true },
    title: 'Lunch',
    start: '2026-10-06T12:00:00',
    timeZone: 'Europe/Berlin',
    duration: 'PT1H',
    updated: '2026-09-26T10:00:00Z',
    ...extra,
  } as CalendarEventWire;
}

export const utc = (iso: string) => Date.parse(iso);
