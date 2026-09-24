import { describe, it, expect } from 'vitest';
import {
  baseEventStoreId,
  buildFallbackExcludePatch,
  buildFallbackOverridePatch,
  buildOccurrencePatch,
  hydrateRecurrenceInstances,
  isBrowserExpandedOccurrence,
  isServerRecurrenceInstance,
  isSyntheticIdMutationUnsupported,
  mergeOverrideParticipants,
  resolveOverrideKey,
  seriesIdOf,
  stableOccurrenceKey,
  withNewOverrideDetails,
} from '../recurrence-instances';
import { expandRecurringEvents } from '../recurrence-expansion';
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
});
