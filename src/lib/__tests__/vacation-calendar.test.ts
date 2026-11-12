// Ported in part from the webmail's lib/__tests__/vacation-calendar.test.ts:
// out of office keeps a busy event in the calendar ("Block my calendar").
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { request, api, policy } = vi.hoisted(() => ({
  request: vi.fn(),
  api: { createEvent: vi.fn(), updateEvent: vi.fn(), deleteEvents: vi.fn(), getCalendars: vi.fn() },
  policy: { effective: null as null | { restrictions: Record<string, unknown>; defaults: Record<string, unknown> } },
}));
vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    accountId: 'alice', username: 'alice@example.org', serverUrl: 'https://mail.example.org', isConnected: true,
    hasCapability: () => true, request,
  },
}));
vi.mock('../../api/calendar', () => api);
vi.mock('../../stores/policy-store', () => ({ usePolicyStore: { getState: () => policy } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) },
}));

import {
  blockTimes, decideBlock, effectiveBlockSetting, eventSpan, isoDuration, oooUid, syncVacationBlock, type DecisionInput,
} from '../vacation-calendar';
import { useVacationCalendarStore } from '../../stores/vacation-calendar-store';

const NOW = new Date('2026-11-10T12:00:00Z');
const reply = (extra: Partial<DecisionInput['reply']> = {}) => ({
  isEnabled: true, fromDate: '2026-12-01T08:00:00Z', toDate: '2026-12-05T17:00:00Z', subject: 'Away', ...extra,
});
const span = (start: string, end: string) => ({ start: new Date(start), end: new Date(end) });
const last = { start: '2026-12-01T08:00:00.000Z', end: '2026-12-05T17:00:00.000Z' };
const input = (extra: Partial<DecisionInput>): DecisionInput => ({
  block: true, reply: reply(), event: null, last: null, now: NOW, trigger: 'save', ...extra,
});

describe('decideBlock', () => {
  it('creates the event for a reply with dates', () => {
    expect(decideBlock(input({}))).toEqual({ action: 'create', start: new Date('2026-12-01T08:00:00Z'), end: new Date('2026-12-05T17:00:00Z') });
  });

  it('moves its own event with the dates', () => {
    const decision = decideBlock(input({ reply: reply({ toDate: '2026-12-08T17:00:00Z' }), event: span(last.start, last.end), last }));
    expect(decision).toEqual({ action: 'update', start: new Date('2026-12-01T08:00:00Z'), end: new Date('2026-12-08T17:00:00Z') });
  });

  it('leaves an event someone edited alone', () => {
    const edited = span('2026-12-01T08:00:00Z', '2026-12-03T12:00:00Z');
    expect(decideBlock(input({ reply: reply({ toDate: '2026-12-08T17:00:00Z' }), event: edited, last }))).toEqual({ action: 'none' });
    expect(decideBlock(input({ reply: reply({ isEnabled: false }), event: edited, last }))).toEqual({ action: 'none' });
  });

  it('removes an event that hasn\'t started when the reply or the block is switched off', () => {
    expect(decideBlock(input({ reply: reply({ isEnabled: false }), event: span(last.start, last.end), last }))).toEqual({ action: 'destroy' });
    expect(decideBlock(input({ block: false, event: span(last.start, last.end), last }))).toEqual({ action: 'destroy' });
  });

  it('ends a running event now when the reply is switched off early', () => {
    const now = new Date('2026-12-03T10:00:00Z');
    expect(decideBlock(input({ reply: reply({ isEnabled: false }), event: span(last.start, last.end), last, now }))).toEqual({ action: 'end-now', end: now });
  });

  it('leaves the past event of a reply that simply ran out', () => {
    const now = new Date('2026-12-06T10:00:00Z');
    expect(decideBlock(input({ event: span(last.start, last.end), last, now }))).toEqual({ action: 'none' });
    expect(decideBlock(input({ now }))).toEqual({ action: 'none' });
  });

  it('keeps a deleted event deleted on load, and brings it back when the dates change', () => {
    expect(decideBlock(input({ last, trigger: 'load' }))).toEqual({ action: 'none' });
    expect(decideBlock(input({ last, trigger: 'load', reply: reply({ toDate: '2026-12-09T17:00:00Z' }) })).action).toBe('create');
  });

  it('follows a reply set in another client on load', () => {
    expect(decideBlock(input({ trigger: 'load' })).action).toBe('create');
  });

  it('does nothing without both dates or with the end before the start', () => {
    expect(decideBlock(input({ reply: reply({ toDate: null }) }))).toEqual({ action: 'none' });
    expect(decideBlock(input({ reply: reply({ toDate: '2026-11-30T00:00:00Z' }) }))).toEqual({ action: 'none' });
  });
});

describe('blockTimes and eventSpan', () => {
  it('writes a timed event in the zone and reads it back', () => {
    const start = new Date('2026-12-01T08:00:00Z');
    const end = new Date('2026-12-05T17:30:00Z');
    const times = blockTimes(start, end, 'Europe/Berlin');
    expect(times).toEqual({ start: '2026-12-01T09:00:00', duration: 'P4DT9H30M', timeZone: 'Europe/Berlin', showWithoutTime: false });
    expect(eventSpan(times, 'Europe/Berlin')).toEqual({ start, end });
  });

  it('writes whole days when both ends are midnight in the zone', () => {
    const start = new Date('2026-11-30T23:00:00Z'); // 1 Dec 00:00 Berlin
    const end = new Date('2026-12-04T23:00:00Z'); // 5 Dec 00:00 Berlin
    const times = blockTimes(start, end, 'Europe/Berlin');
    expect(times).toEqual({ start: '2026-12-01T00:00:00', duration: 'P4D', timeZone: null, showWithoutTime: true });
    expect(eventSpan(times, 'Europe/Berlin')).toEqual({ start, end });
  });

  it('formats durations', () => {
    expect(isoDuration(90 * 60000)).toBe('PT1H30M');
    expect(isoDuration(2 * 86400000)).toBe('P2D');
    expect(isoDuration(0)).toBe('PT0S');
  });
});

describe('effectiveBlockSetting', () => {
  beforeEach(() => {
    policy.effective = null;
    useVacationCalendarStore.setState({ block: null, written: {} });
  });

  it('is on by default, the choice of the user otherwise, and of the organisation when locked', () => {
    expect(effectiveBlockSetting()).toBe(true);
    useVacationCalendarStore.setState({ block: false });
    expect(effectiveBlockSetting()).toBe(false);
    policy.effective = { restrictions: { vacationBlockCalendar: { locked: true, value: true } }, defaults: {} };
    expect(effectiveBlockSetting()).toBe(true);
  });
});

describe('syncVacationBlock', () => {
  const found = (event: Record<string, unknown> | null) => request.mockResolvedValue({
    methodResponses: [['CalendarEvent/query', { ids: event ? ['e1'] : [] }, '0'], ['CalendarEvent/get', { list: event ? [event] : [] }, '1']],
  });

  beforeEach(() => {
    policy.effective = null;
    useVacationCalendarStore.setState({ block: null, written: {} });
    request.mockReset();
    for (const fn of Object.values(api)) fn.mockReset();
    api.getCalendars.mockResolvedValue([{ id: 'b', name: 'Calendar', isDefault: true, myRights: { mayWriteAll: true } }]);
  });

  it('adds a busy event for a reply with dates, under its UID, and remembers it', async () => {
    found(null);
    expect(await syncVacationBlock(undefined, reply(), 'save', NOW)).toBe('create');
    const [event, calendarId, sendScheduling] = api.createEvent.mock.calls[0];
    expect(calendarId).toBe('b');
    expect(sendScheduling).toBe(false);
    expect(event).toMatchObject({ uid: oooUid('alice'), title: 'Away', freeBusyStatus: 'busy', privacy: 'public', keywords: { 'bulwark-out-of-office': true } });
    expect(Object.values(useVacationCalendarStore.getState().written)).toEqual([last]);
  });

  // Its own by the reply's dates before the change, on any device.
  it('removes its event that has not started when the reply is switched off', async () => {
    found({ id: 'e1', ...blockTimes(new Date(last.start), new Date(last.end), 'UTC'), timeZone: 'UTC' });
    const result = await syncVacationBlock(undefined, reply({ isEnabled: false }), 'save', NOW, { fromDate: last.start, toDate: last.end });
    expect(result).toBe('destroy');
    expect(api.deleteEvents).toHaveBeenCalledWith(['e1'], false, undefined);
  });

  it('leaves an event someone else made alone', async () => {
    found({ id: 'e1', start: '2026-12-02T09:00:00', duration: 'PT1H', timeZone: 'UTC' });
    expect(await syncVacationBlock(undefined, reply(), 'save', NOW)).toBe('none');
    expect(api.createEvent).not.toHaveBeenCalled();
    expect(api.updateEvent).not.toHaveBeenCalled();
  });

  it('says so when the account has no calendar it may write to', async () => {
    found(null);
    api.getCalendars.mockResolvedValue([{ id: 'b', name: 'Calendar', isDefault: true, myRights: { mayWriteAll: false, mayWriteOwn: false } }]);
    expect(await syncVacationBlock(undefined, reply(), 'save', NOW)).toBe('no-calendar');
  });
});

// No render setup in the repo: the settings page and the store are checked
// for offering the block and keeping the event in line after a save.
describe('Block my calendar wiring', () => {
  it('is under the out-of-office dates and follows every save and load of the reply', () => {
    const page = readFileSync(join(__dirname, '../../components/settings/VacationSettings.tsx'), 'utf-8');
    expect(page).toMatch(/<VacationCalendarBlock hasDates=\{!!fromParsed && !!toParsed\} accountId=\{managedAccountId \?\? undefined\} \/>/);
    const store = readFileSync(join(__dirname, '../../stores/vacation-store.ts'), 'utf-8');
    expect(store).toMatch(/m\.vacationReplySaved\(accountId, before, after\)/);
    expect(store).toMatch(/m\.vacationReplyLoaded\(accountId, loadedReply\)/);
  });
});
