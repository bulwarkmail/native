import { describe, it, expect } from 'vitest';
import {
  baseEventStoreId,
  buildFallbackExcludePatch,
  buildFallbackOverridePatch,
  buildOccurrencePatch,
  buildOccurrenceRsvpPatch,
  hydrateRecurrenceInstances,
  isBrowserExpandedOccurrence,
  isOverrideSeriesKeyRejection,
  isServerRecurrenceInstance,
  isSyntheticIdMutationUnsupported,
  mergeOverrideParticipants,
  resolveOverrideKey,
  seriesIdOf,
  stableOccurrenceKey,
  withNewOverrideDetails,
  withoutOverrideSeriesKeys,
} from '../recurrence-instances';
import { expandRecurringEvents } from '../recurrence-expansion';
import { JMAPMethodError } from '../../api/jmap-result';
import type { CalendarEvent } from '../../api/types';

function ev(partial: Partial<CalendarEvent>): CalendarEvent {
  return { id: 'e', uid: 'u', title: 't', start: '2026-03-02T09:00:00', calendarIds: { c: true }, ...partial } as CalendarEvent;
}

describe('server recurrence instances', () => {
  it('tells a server-expanded occurrence from a stored event', () => {
    expect(isServerRecurrenceInstance(ev({ id: 's1', baseEventId: 'base' }))).toBe(true);
    // Shared account: the store id is namespaced, originalId holds the raw id.
    expect(isServerRecurrenceInstance(ev({ id: 'acc:s1', originalId: 's1', baseEventId: 'base' }))).toBe(true);
    // A stored event fetched directly names itself.
    expect(isServerRecurrenceInstance(ev({ id: 'base', baseEventId: 'base' }))).toBe(false);
    expect(isServerRecurrenceInstance(ev({ id: 'acc:base', originalId: 'base', baseEventId: 'base' }))).toBe(false);
    expect(isServerRecurrenceInstance(ev({ id: 'x:2026', originalId: 'x' }))).toBe(false);
  });

  it('names the base event under the store id it would have', () => {
    expect(baseEventStoreId(ev({ id: 's1', baseEventId: 'base' }))).toBe('base');
    expect(baseEventStoreId(ev({ id: 'acc:s1', originalId: 's1', baseEventId: 'base' }))).toBe('acc:base');
    expect(baseEventStoreId(ev({ id: 'base' }))).toBeNull();
  });

  it('finds the stored event behind any store event', () => {
    expect(seriesIdOf(ev({ id: 's1', baseEventId: 'base' }))).toBe('base');
    expect(seriesIdOf(ev({ id: 'm:2026-03-02T09:00:00', originalId: 'm' }))).toBe('m');
    expect(seriesIdOf(ev({ id: 'plain' }))).toBe('plain');
  });

  it('keys an occurrence by what survives a refetch', () => {
    expect(stableOccurrenceKey(ev({ id: 's7', baseEventId: 'base', recurrenceId: '2026-03-02T09:00:00' })))
      .toBe('base:2026-03-02T09:00:00');
    expect(stableOccurrenceKey(ev({ id: 'acc:s7', originalId: 's7', accountId: 'acc', baseEventId: 'base' })))
      .toBe('acc:base');
    expect(stableOccurrenceKey(ev({ id: 'm:2026-03-02T09:00:00', originalId: 'm', recurrenceId: '2026-03-02T09:00:00' })))
      .toBe('m:2026-03-02T09:00:00');
  });

  it('finds a moved occurrence\'s override by its new start on older servers', () => {
    const overrides = { '2026-03-02T09:00:00': { start: '2026-03-02T11:00:00' } };
    expect(resolveOverrideKey({ recurrenceId: '2026-03-02T09:00:00', start: '2026-03-02T11:00:00' }, overrides))
      .toBe('2026-03-02T09:00:00');
    expect(resolveOverrideKey({ recurrenceId: '2026-03-02T11:00:00', start: '2026-03-02T11:00:00' }, overrides))
      .toBe('2026-03-02T09:00:00');
    expect(resolveOverrideKey({ recurrenceId: '2026-03-04T09:00:00', start: '2026-03-04T09:00:00' }, overrides))
      .toBe('2026-03-04T09:00:00');
    expect(resolveOverrideKey({ start: '2026-03-04T09:00:00' }, overrides)).toBeNull();
  });

  it('completes an override\'s participants from the series', () => {
    const series = {
      org: { calendarAddress: 'mailto:org@x', roles: { owner: true }, participationStatus: 'accepted' },
      a: { calendarAddress: 'mailto:a@x', participationStatus: 'needs-action' },
    } as unknown as CalendarEvent['participants'];
    const override = {
      o2: { calendarAddress: 'MAILTO:org@x', participationStatus: null },
      a: { participationStatus: 'declined' },
    } as unknown as CalendarEvent['participants'];

    expect(mergeOverrideParticipants(series, override)).toEqual({
      org: { calendarAddress: 'MAILTO:org@x', roles: { owner: true }, participationStatus: 'accepted' },
      a: { calendarAddress: 'mailto:a@x', participationStatus: 'declined' },
    });
  });
});

describe('hydrateRecurrenceInstances', () => {
  const base = {
    id: 'base',
    recurrenceRules: [{ frequency: 'weekly' }],
    recurrenceOverrides: { '2026-03-09T09:00:00': { title: 'Moved', start: '2026-03-09T11:00:00' } },
    showWithoutTime: false,
    timeZone: 'Europe/Berlin',
    duration: 'PT1H',
  } as Partial<CalendarEvent>;
  const bases = new Map([['base', base]]);

  it('copies the series context and the base duration of an override without one', () => {
    const [plain, overridden] = hydrateRecurrenceInstances([
      ev({ id: 's1', baseEventId: 'base', recurrenceId: '2026-03-02T09:00:00', duration: 'PT1H' }),
      ev({
        id: 's2', baseEventId: 'base', recurrenceId: '2026-03-09T09:00:00', start: '2026-03-09T11:00:00',
        title: 'Moved', duration: 'PT2H', utcStart: '2026-03-09T10:00:00Z', utcEnd: '2026-03-09T12:00:00Z',
      }),
    ], bases);

    expect(plain.recurrenceRules).toEqual([{ frequency: 'weekly' }]);
    expect(plain.recurrenceOverrides).toBe(base.recurrenceOverrides);
    expect(overridden.duration).toBe('PT1H');
    expect(overridden.utcEnd).toBe('2026-03-09T11:00:00.000Z');
  });

  it('restores the all-day flag the expansion dropped', () => {
    const allDay = new Map([['b2', { id: 'b2', showWithoutTime: true, timeZone: null, duration: 'P1D' }]]);
    const [hydrated] = hydrateRecurrenceInstances(
      [ev({ id: 's1', baseEventId: 'b2', recurrenceId: '2026-03-02T00:00:00', timeZone: 'Europe/Berlin' })],
      allDay,
    );
    expect(hydrated.showWithoutTime).toBe(true);
    expect(hydrated.timeZone).toBeNull();
  });

  it('collapses an occurrence listed twice, taking the override\'s own fields', () => {
    const withReply = new Map([['base', {
      ...base,
      recurrenceOverrides: { '2026-03-02T09:00:00': { participants: { a: { participationStatus: 'accepted' } } } },
    }]]);
    const series = ev({
      id: 's1', baseEventId: 'base', recurrenceId: '2026-03-02T09:00:00', title: 'Standup',
      participants: { a: { calendarAddress: 'mailto:a@x', participationStatus: 'needs-action' } } as any,
    });
    const fromOverride = ev({
      id: 's1', baseEventId: 'base', recurrenceId: '2026-03-02T09:00:00', title: '',
      participants: { a: { participationStatus: 'accepted' } } as any,
    });

    const result = hydrateRecurrenceInstances([series, fromOverride], withReply);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Standup');
    expect(result[0].participants).toEqual({
      a: { calendarAddress: 'mailto:a@x', participationStatus: 'accepted' },
    });
  });

  it('leaves events without a known base alone', () => {
    const lone = ev({ id: 's9', baseEventId: 'unknown', recurrenceId: '2026-03-02T09:00:00' });
    expect(hydrateRecurrenceInstances([lone], bases)[0]).toBe(lone);
  });
});

describe('expandRecurringEvents with server occurrences', () => {
  it('never expands an occurrence the server already expanded', () => {
    const occurrence = ev({
      id: 's1', baseEventId: 'base', recurrenceId: '2026-03-02T09:00:00',
      recurrenceRules: [{ frequency: 'daily' } as any],
    });
    const result = expandRecurringEvents([occurrence], '2026-03-01T00:00:00', '2026-03-31T00:00:00');
    expect(result).toEqual([occurrence]);
  });
});

describe('changing one occurrence', () => {
  it('recognises a server that refuses synthetic ids', () => {
    expect(isSyntheticIdMutationUnsupported(new Error('Updating synthetic ids is not yet supported.'))).toBe(true);
    expect(isSyntheticIdMutationUnsupported(
      new Error('Failed to destroy event s1: invalidProperties – Deleting synthetic ids is not yet supported.'),
    )).toBe(true);
    expect(isSyntheticIdMutationUnsupported(new Error('forbidden'))).toBe(false);
  });

  it('tells an occurrence the device expanded from a server one', () => {
    const rules = [{ frequency: 'daily' } as any];
    expect(isBrowserExpandedOccurrence(ev({ id: 'm:x', originalId: 'm', recurrenceId: 'x', recurrenceRules: rules }))).toBe(true);
    expect(isBrowserExpandedOccurrence(ev({ id: 's1', baseEventId: 'm', recurrenceId: 'x', recurrenceRules: rules }))).toBe(false);
    expect(isBrowserExpandedOccurrence(ev({ id: 'lone', recurrenceId: 'x' }))).toBe(false);
  });

  it('keeps only what one occurrence may carry, also behind a pointer', () => {
    expect(buildOccurrencePatch({
      title: 'x',
      'locations/l1/name': 'Room',
      'calendarIds/c2': true,
      recurrenceRules: [],
      recurrenceId: 'r',
      utcStart: 'z',
      useDefaultAlerts: true,
      originalId: 'o',
    } as any)).toEqual({ title: 'x', 'locations/l1/name': 'Room' });
  });

  it('builds an override that keeps what the occurrence already overrides', () => {
    const occurrence = ev({
      id: 'm:2026-03-03T09:00:00', originalId: 'm', recurrenceId: '2026-03-03T09:00:00',
      start: '2026-03-03T11:00:00', duration: 'PT1H', recurrenceRules: [{ frequency: 'daily' } as any],
      recurrenceOverrides: {
        '2026-03-03T09:00:00': { start: '2026-03-03T11:00:00', title: 'Late', updated: '2026-01-01T00:00:00Z' } as any,
      },
    });

    expect(buildFallbackOverridePatch(occurrence, { description: 'Bring slides' })).toEqual({
      'recurrenceOverrides/2026-03-03T09:00:00': {
        start: '2026-03-03T11:00:00',
        duration: 'PT1H',
        title: 'Late',
        description: 'Bring slides',
      },
    });
    expect(buildFallbackExcludePatch(occurrence)).toEqual({
      'recurrenceOverrides/2026-03-03T09:00:00': { excluded: true },
    });
  });

  it('copies the occurrence details into a new override only', () => {
    const fresh = ev({
      id: 's1', baseEventId: 'm', recurrenceId: '2026-03-02T09:00:00', title: 'Standup',
      alerts: { a: {} } as any, sequence: 3, recurrenceOverrides: null,
    });
    expect(withNewOverrideDetails(fresh, { start: '2026-03-02T10:00:00' })).toEqual({
      title: 'Standup', alerts: { a: {} }, sequence: 3, start: '2026-03-02T10:00:00',
    });

    const overridden = { ...fresh, recurrenceOverrides: { '2026-03-02T09:00:00': { title: 'Standup' } } };
    expect(withNewOverrideDetails(overridden, { start: '2026-03-02T10:00:00' }))
      .toEqual({ start: '2026-03-02T10:00:00' });

    // Not hydrated: the base event's overrides are unknown, so nothing is guessed.
    const unknown = { ...fresh, recurrenceOverrides: undefined };
    expect(withNewOverrideDetails(unknown, { start: '2026-03-02T10:00:00' }))
      .toEqual({ start: '2026-03-02T10:00:00' });
    expect(buildFallbackExcludePatch(unknown)).toEqual({
      'recurrenceOverrides/2026-03-02T09:00:00': { excluded: true },
    });
  });

  it('answers one occurrence with the whole participant map', () => {
    const occurrence = ev({
      id: 's1', baseEventId: 'm', recurrenceId: '2026-03-02T09:00:00', title: 'Standup',
      organizerCalendarAddress: 'mailto:org@x', sequence: 1,
      recurrenceOverrides: { '2026-03-02T09:00:00': {} },
      participants: {
        org: { calendarAddress: 'mailto:org@x', participationStatus: 'accepted' },
        me: { calendarAddress: 'mailto:me@x', participationStatus: 'needs-action' },
      } as any,
    });
    const participants = {
      org: { calendarAddress: 'mailto:org@x', participationStatus: 'accepted' },
      me: { calendarAddress: 'mailto:me@x', participationStatus: 'accepted' },
    };

    // Through a synthetic id: the organizer is the series', which Stalwart
    // 1.0 checks against the base event.
    expect(buildOccurrenceRsvpPatch(occurrence, 'me', 'accepted')).toEqual({ sequence: 1, participants });
    // In an override on the base event: 0.16.19 needs the organizer there.
    expect(buildOccurrenceRsvpPatch(occurrence, 'me', 'accepted', { seriesKeys: true })).toEqual({
      sequence: 1,
      organizerCalendarAddress: 'mailto:org@x',
      participants,
    });
    expect(buildOccurrenceRsvpPatch(occurrence, 'nobody', 'accepted')).toBeNull();
  });
});

// Stalwart 1.0 checks what one occurrence carries (jmap/src/calendar_event/
// validate.rs): through a synthetic id a series property must repeat the base
// event's value, inside an override on the base event it is refused whatever
// its value. 0.16.20-0.16.23 drop such keys silently; older 0.16 store them.
describe('series keys on one occurrence', () => {
  it('leaves the series keys and pointers at an address out of an occurrence patch', () => {
    const patch = buildOccurrencePatch({
      privacy: 'public',
      organizerCalendarAddress: 'mailto:me@example.com',
      method: 'request',
      prodId: '-//Bulwark//EN',
      sentBy: 'mailto:assistant@example.com',
      recurrenceRule: { frequency: 'daily' },
      excludedRecurrenceRule: null,
      'participants/p1/calendarAddress': 'mailto:other@example.com',
      'participants/p1/participationStatus': 'declined',
      participants: { p1: { '@type': 'Participant', calendarAddress: 'mailto:p1@example.com' } },
      relatedTo: { r1: { '@type': 'Relation' } },
      sequence: 3,
      excluded: false,
      status: 'tentative',
      freeBusyStatus: 'free',
      accountId: 'acc-2',
    } as unknown as Partial<CalendarEvent>);

    expect(patch).toEqual({
      'participants/p1/participationStatus': 'declined',
      participants: { p1: { '@type': 'Participant', calendarAddress: 'mailto:p1@example.com' } },
      relatedTo: { r1: { '@type': 'Relation' } },
      sequence: 3,
      excluded: false,
      status: 'tentative',
      freeBusyStatus: 'free',
    });
  });

  it('keeps the organizer in an override on the base event, as 0.16 has always been sent it', () => {
    const occurrence = ev({
      id: 'm:2026-03-03T09:00:00', originalId: 'm', recurrenceId: '2026-03-03T09:00:00',
      start: '2026-03-03T09:00:00', duration: 'PT1H', recurrenceRules: [{ frequency: 'daily' } as any],
      recurrenceOverrides: null,
    });

    expect(buildFallbackOverridePatch(occurrence, {
      title: 'x', organizerCalendarAddress: 'mailto:org@example.com', uid: 'u', calendarIds: { c: true },
    })).toEqual({
      recurrenceOverrides: {
        '2026-03-03T09:00:00': {
          start: '2026-03-03T09:00:00', duration: 'PT1H', title: 'x', organizerCalendarAddress: 'mailto:org@example.com',
        },
      },
    });
  });

  it('copies the organizer into a new override only when it goes on the base event', () => {
    const occurrence = ev({
      id: 's1', baseEventId: 'm', recurrenceId: '2026-03-02T09:00:00', title: 'Standup',
      organizerCalendarAddress: 'mailto:org@example.com', recurrenceOverrides: null,
    });

    expect(withNewOverrideDetails(occurrence, { start: 'x' })).not.toHaveProperty('organizerCalendarAddress');
    expect(withNewOverrideDetails(occurrence, { start: 'x' }, { seriesKeys: true })).toMatchObject({
      organizerCalendarAddress: 'mailto:org@example.com',
    });
  });

  it('takes the series and per-event keys out of every override an update writes', () => {
    expect(withoutOverrideSeriesKeys({
      title: 'Series title',
      organizerCalendarAddress: 'mailto:org@example.com',
      recurrenceOverrides: {
        '2026-09-08T10:00:00': { title: 'Moved', privacy: 'public', organizerCalendarAddress: 'mailto:o@example.com' },
        '2026-09-09T10:00:00': { excluded: true },
      },
    })).toEqual({
      title: 'Series title',
      organizerCalendarAddress: 'mailto:org@example.com',
      recurrenceOverrides: {
        '2026-09-08T10:00:00': { title: 'Moved' },
        '2026-09-09T10:00:00': { excluded: true },
      },
    });
  });

  it('takes them out of an override entry and of pointers into one', () => {
    expect(withoutOverrideSeriesKeys({
      'recurrenceOverrides/2026-09-08T10:00:00': { start: '2026-09-08T12:00:00', privacy: 'public', uid: 'x' },
      'recurrenceOverrides/2026-09-09T10:00:00/privacy': 'public',
      'recurrenceOverrides/2026-09-09T10:00:00/participants/p1/calendarAddress': 'mailto:x@example.com',
      'recurrenceOverrides/2026-09-09T10:00:00/participants/p1/participationStatus': 'accepted',
      'recurrenceOverrides/2026-09-10T10:00:00': null,
    })).toEqual({
      'recurrenceOverrides/2026-09-08T10:00:00': { start: '2026-09-08T12:00:00' },
      'recurrenceOverrides/2026-09-09T10:00:00/participants/p1/participationStatus': 'accepted',
      'recurrenceOverrides/2026-09-10T10:00:00': null,
    });
  });

  it('recognises Stalwart 1.0 refusing a series key inside an override', () => {
    expect(isOverrideSeriesKeyRejection(
      new JMAPMethodError('invalidProperties', 'organizerCalendarAddress cannot be set inside recurrenceOverrides.'),
    )).toBe(true);
    expect(isOverrideSeriesKeyRejection(
      new JMAPMethodError('invalidProperties', 'This property cannot be modified on a single occurrence.'),
    )).toBe(false);
    // Without the SetError type it is not recognised.
    expect(isOverrideSeriesKeyRejection(new Error('privacy cannot be set inside recurrenceOverrides.'))).toBe(false);
  });
});
