import { describe, it, expect } from 'vitest';
import { applyOverridePatch } from '../recurrence-instances';
import type { CalendarEvent } from '../../api/types';

// A recurrence override is an RFC 8984 PatchObject: its keys are JSON
// Pointers into the occurrence, and null removes what one points at. Stalwart
// 1.0 returns minimal patches (jmap/src/calendar_event/get.rs, conformance
// test "Figures 2-6"); 0.16 returned whole top-level values.

const series = {
  id: 'b',
  title: 'Team sync',
  description: 'Agenda',
  locations: { l1: { '@type': 'Location', name: 'Room A' } },
  participants: {
    org: { '@type': 'Participant', calendarAddress: 'mailto:a@example.org', participationStatus: 'accepted' },
    tom: { '@type': 'Participant', calendarAddress: 'mailto:b@example.org', participationStatus: 'needs-action' },
    'a/b': { '@type': 'Participant', calendarAddress: 'mailto:c@example.org', participationStatus: 'needs-action' },
    'x~y': { '@type': 'Participant', calendarAddress: 'mailto:d@example.org', participationStatus: 'needs-action' },
  },
} as unknown as CalendarEvent;

describe('applyOverridePatch', () => {
  it('sets what a pointer names on Stalwart 1.0, leaving the rest and the series untouched', () => {
    const before = JSON.stringify(series);
    const occurrence = applyOverridePatch(series, { 'participants/tom/participationStatus': 'declined' });

    expect(occurrence.participants?.tom.participationStatus).toBe('declined');
    expect(occurrence.participants?.org).toBe(series.participants?.org);
    expect(occurrence).not.toHaveProperty(['participants/tom/participationStatus']);
    expect(JSON.stringify(series)).toBe(before);
  });

  it('reads escaped tokens: ~1 is a slash, ~0 a tilde', () => {
    const occurrence = applyOverridePatch(series, {
      'participants/a~1b/participationStatus': 'accepted',
      'participants/x~0y/participationStatus': 'tentative',
    });
    expect(occurrence.participants?.['a/b'].participationStatus).toBe('accepted');
    expect(occurrence.participants?.['x~y'].participationStatus).toBe('tentative');
  });

  it('removes what null points at, at the top and further down', () => {
    const occurrence = applyOverridePatch(series, { description: null, 'participants/tom': null, 'links/none': null });
    expect(occurrence).not.toHaveProperty('description');
    expect(Object.keys(occurrence.participants ?? {})).toEqual(['org', 'a/b', 'x~y']);
    // Nothing to remove under a member that is not there.
    expect(occurrence).not.toHaveProperty('links');
  });

  it('creates the members a pointer needs', () => {
    const occurrence = applyOverridePatch(series, { 'keywords/$flagged': true });
    expect((occurrence as unknown as { keywords: unknown }).keywords).toEqual({ $flagged: true });
  });

  it('applies whole values the way 0.16 returns them, completing participants from the series', () => {
    const occurrence = applyOverridePatch(series, {
      title: 'Moved sync',
      start: '2026-09-08T14:00:00',
      participants: {
        tom: { '@type': 'Participant', calendarAddress: 'mailto:b@example.org', participationStatus: 'declined' },
        n1: { '@type': 'Participant', calendarAddress: 'mailto:a@example.org' },
      },
    });
    expect(occurrence.title).toBe('Moved sync');
    expect(occurrence.start).toBe('2026-09-08T14:00:00');
    expect(occurrence.participants).toEqual({
      tom: { '@type': 'Participant', calendarAddress: 'mailto:b@example.org', participationStatus: 'declined' },
      org: { '@type': 'Participant', calendarAddress: 'mailto:a@example.org', participationStatus: 'accepted' },
    });
  });

  it('applies shorter paths first, so a pointer refines a value set whole in the same patch', () => {
    const occurrence = applyOverridePatch(series, {
      'locations/l1/name': 'Room B',
      locations: { l1: { '@type': 'Location', name: 'Room C', description: 'Second floor' } },
    });
    expect(occurrence.locations).toEqual({ l1: { '@type': 'Location', name: 'Room B', description: 'Second floor' } });
  });
});
