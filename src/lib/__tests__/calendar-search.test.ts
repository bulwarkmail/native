import { describe, it, expect } from 'vitest';
import type { CalendarEvent } from '../../api/types';
import { eventMatches, orderSearchResults, searchFilter, searchTerms } from '../calendar-search';

const ev = (partial: Partial<CalendarEvent>): CalendarEvent => ({
  id: 'e', uid: 'u', title: 'Event', calendarIds: { c: true }, start: '2026-03-02T09:00:00', duration: 'PT1H',
  ...partial,
} as CalendarEvent);

describe('calendar search', () => {
  it('asks the server for every word', () => {
    expect(searchTerms('  Team   Sync ')).toEqual(['team', 'sync']);
    expect(searchFilter(['team'])).toEqual({ text: 'team' });
    expect(searchFilter(['team', 'sync'])).toEqual({ operator: 'AND', conditions: [{ text: 'team' }, { text: 'sync' }] });
    expect(searchFilter([])).toBeNull();
  });

  it('matches the loaded events by title, place, description and participants', () => {
    const event = ev({
      title: 'Quarterly review',
      description: 'Budget',
      locations: { l: { '@type': 'Location', name: 'Room Atlas' } } as never,
      participants: { p: { calendarAddress: 'mailto:dana@example.com', name: 'Dana' } } as never,
    });
    expect(eventMatches(event, searchTerms('review atlas'))).toBe(true);
    expect(eventMatches(event, searchTerms('budget dana@example'))).toBe(true);
    expect(eventMatches(event, searchTerms('review lunch'))).toBe(false);
    expect(eventMatches(event, [])).toBe(false);
  });

  it('shows a series once, by its next occurrence, and the server\'s finds the window lacks', () => {
    const now = new Date('2026-03-10T12:00:00').getTime();
    const occurrence = (day: string) => ev({ id: `s:${day}`, uid: 'series', title: 'Standup', start: `2026-03-${day}T09:00:00`, recurrenceId: `2026-03-${day}T09:00:00` });
    const local = [occurrence('09'), occurrence('16'), occurrence('11')];
    const server = [
      ev({ id: 'series-base', uid: 'series', title: 'Standup', start: '2026-01-05T09:00:00', recurrenceRules: [{ frequency: 'weekly' }] as never }),
      ev({ id: 'old', uid: 'old', title: 'Standup retro', start: '2025-11-01T09:00:00' }),
    ];
    const { upcoming, past } = orderSearchResults(local, server, now);
    expect(upcoming.map((e) => e.id)).toEqual(['s:11']);
    expect(past.map((e) => e.id)).toEqual(['old']);
  });
});
