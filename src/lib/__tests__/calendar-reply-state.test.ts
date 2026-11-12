import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gridReplyState, gridTitle } from '../calendar-reply-state';
import type { CalendarEvent } from '../../api/types';

// Webmail 1.21 (pim-9): unanswered invitations are marked in the grid.
const me = ['usera@example.org'];
const invitation = (status?: string, extra: Partial<CalendarEvent> = {}) => ({
  id: 'e', uid: 'u', calendarIds: { c: true }, title: 'Review', start: '2026-11-20T10:00:00',
  organizerCalendarAddress: 'mailto:bob@example.org',
  participants: {
    bob: { '@type': 'Participant', calendarAddress: 'mailto:bob@example.org', email: 'bob@example.org', roles: { owner: true } },
    me: { '@type': 'Participant', calendarAddress: 'mailto:usera@example.org', email: 'usera@example.org', roles: { attendee: true }, ...(status ? { participationStatus: status } : {}) },
  },
  ...extra,
}) as unknown as CalendarEvent;

describe('unanswered invitations on the grid', () => {
  it('marks an invitation the user has not answered', () => {
    expect(gridReplyState(invitation('needs-action'), me)).toBe('needs-action');
    expect(gridReplyState(invitation(), me)).toBe('needs-action');
    expect(gridTitle(invitation(), 'Review', me)).toBe('? Review');
  });

  it('leaves answered, cancelled and own events alone', () => {
    expect(gridTitle(invitation('accepted'), 'Review', me)).toBe('Review');
    expect(gridReplyState(invitation('tentative'), me)).toBe('tentative');
    expect(gridTitle(invitation('tentative'), 'Review', me)).toBe('Review');
    expect(gridTitle(invitation(undefined, { status: 'cancelled' }), 'Review', me)).toBe('Review');
    expect(gridTitle(invitation(), 'Review', ['bob@example.org'])).toBe('Review');
    expect(gridTitle({ ...invitation(), organizerCalendarAddress: undefined, participants: undefined } as CalendarEvent, 'Mine', me)).toBe('Mine');
  });

  // No render setup in the repo: the month, week/day and agenda chips are read.
  it('is what month, week, day and agenda show', () => {
    const src = (f: string) => readFileSync(join(__dirname, '../../components/calendar', f), 'utf-8');
    expect(src('MonthView.tsx').match(/gridTitle\(event, event\.title/g)?.length).toBe(2);
    expect(src('TimeGridScrollView.tsx').match(/gridTitle\((segment\.)?event, /g)?.length).toBe(2);
    expect(src('EventCard.tsx')).toContain('gridTitle(event, event.title');
  });
});
