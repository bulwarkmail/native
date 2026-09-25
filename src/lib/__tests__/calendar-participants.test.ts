import { describe, it, expect } from 'vitest';
import type { CalendarEvent } from '../../api/types';
import {
  buildParticipantMap,
  collectUserCalendarAddresses,
  getParticipantCount,
  getParticipantList,
  getStatusCounts,
  getUserParticipantId,
  isOrganizer,
  participantFieldsToSave,
  seedAttendees,
} from '../calendar-participants';

const event: Partial<CalendarEvent> = {
  organizerCalendarAddress: 'mailto:Alice@example.com',
  participants: {
    // Stalwart rebuilds ORGANIZER into a roles-less participant (#731).
    org: { calendarAddress: 'mailto:alice@example.com', name: 'Alice' },
    bob: { email: 'bob@example.com', roles: { attendee: true }, participationStatus: 'accepted' },
    carol: { calendarAddress: 'mailto:carol@example.com', roles: { attendee: true } },
  },
};

describe('buildParticipantMap', () => {
  it('emits an owner-only organizer plus server-scheduled attendees, deduped (#731)', () => {
    const map = buildParticipantMap({ name: 'Alice', email: 'alice@example.com' }, [
      { name: 'Bob', email: 'bob@example.com' },
      { name: 'Alice again', email: 'ALICE@example.com' },
      { name: 'Bob dup', email: 'Bob@example.com' },
    ]);
    const list = Object.values(map);
    expect(list).toHaveLength(2);
    const organizer = list.find((p) => p.roles?.owner)!;
    expect(organizer.roles).toEqual({ owner: true });
    expect(organizer.calendarAddress).toBe('mailto:alice@example.com');
    expect(organizer.scheduleAgent).toBe('server');
    expect(organizer.sendTo).toBeUndefined();
    const bob = list.find((p) => p.email === 'bob@example.com')!;
    expect(bob.roles).toEqual({ attendee: true });
    expect(bob.calendarAddress).toBe('mailto:bob@example.com');
    expect(bob.scheduleAgent).toBe('server');
    expect(bob.expectReply).toBe(true);
    expect(bob.participationStatus).toBe('needs-action');
  });
});

describe('collectUserCalendarAddresses', () => {
  it('merges groups, dedupes case-insensitively and drops blanks', () => {
    expect(
      collectUserCalendarAddresses(['Me@example.com'], ['me@example.com', ' ', null, 'alias@example.com']),
    ).toEqual(['Me@example.com', 'alias@example.com']);
  });
});

describe('organizer / participant detection', () => {
  it('recognises the organizer via organizerCalendarAddress and an alias', () => {
    expect(isOrganizer(event, ['alice@example.com'])).toBe(true);
    expect(isOrganizer(event, ['bob@example.com'])).toBe(false);
    expect(isOrganizer(event, [])).toBe(false);
  });

  it('finds the user participant by calendarAddress', () => {
    expect(getUserParticipantId(event, ['CAROL@example.com'])).toBe('carol');
    expect(getUserParticipantId(event, ['nobody@example.com'])).toBeNull();
  });

  it('marks the roles-less organizer participant as organizer', () => {
    const list = getParticipantList(event);
    expect(list.find((p) => p.id === 'org')?.isOrganizer).toBe(true);
    expect(list.find((p) => p.id === 'bob')?.isOrganizer).toBe(false);
    expect(list.find((p) => p.id === 'carol')?.email).toBe('carol@example.com');
  });

  it('does not count the organizer in status totals', () => {
    expect(getStatusCounts(event)).toEqual({ accepted: 1, declined: 0, tentative: 0, 'needs-action': 1 });
  });
});

describe('seedAttendees', () => {
  it('never seeds the organizer or a repeated address (#731)', () => {
    const attendees = seedAttendees(event, ['alice@example.com']);
    expect(attendees.map((a) => a.email)).toEqual(['bob@example.com', 'carol@example.com']);
  });

  it('round-trips through buildParticipantMap without duplicating the organizer', () => {
    const attendees = seedAttendees(event, ['alice@example.com']);
    const map = buildParticipantMap({ name: 'Alice', email: 'alice@example.com' }, attendees);
    const emails = Object.values(map).map((p) => p.email?.toLowerCase());
    expect(emails.filter((e) => e === 'alice@example.com')).toHaveLength(1);
    expect(emails).toHaveLength(3);
  });
});

describe('getParticipantList dedupe, names and organizer status', () => {
  const org = { name: 'Alice', email: 'alice@example.com', roles: { owner: true }, participationStatus: 'accepted' as const };
  const bob = { name: 'Bob', email: 'bob@example.com', roles: { attendee: true }, participationStatus: 'needs-action' as const };

  it('renders the organizer once when the server also emits them as an attendee', () => {
    const list = getParticipantList({
      organizerCalendarAddress: 'mailto:alice@example.com',
      participants: {
        org: { ...org, name: '' },
        att1: bob,
        att2: { ...bob, name: 'Carol', email: 'carol@example.com' },
        orgDup: { ...bob, name: '', email: 'alice@example.com' },
      },
    });
    expect(list).toHaveLength(3);
    const alices = list.filter((p) => p.email === 'alice@example.com');
    expect(alices).toHaveLength(1);
    expect(alices[0]).toMatchObject({ isOrganizer: true, status: 'accepted' });
  });

  it('keeps the real RSVP when the first entry of an address never replied', () => {
    const list = getParticipantList({
      organizerCalendarAddress: 'mailto:alice@example.com',
      participants: {
        att1: { ...bob, name: '', email: 'alice@example.com' },
        org,
      },
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ isOrganizer: true, status: 'accepted', name: 'Alice' });
  });

  it('merges duplicate attendees case-insensitively, first-seen name wins', () => {
    const list = getParticipantList({
      participants: {
        att1: bob,
        att2: { ...bob, name: 'Bobby', email: 'BOB@example.com', participationStatus: 'accepted' },
      },
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Bob', status: 'accepted' });
  });

  it('shows a statusless organizer as accepted, not pending', () => {
    const list = getParticipantList(event);
    expect(list.find((p) => p.isOrganizer)?.status).toBe('accepted');
  });

  it('fills missing names from resolveName without overriding event data', () => {
    const resolveName = (email: string) => (email.startsWith('alice') || email.startsWith('bob') ? 'Contact' : undefined);
    const list = getParticipantList(
      { participants: { org: { ...org, name: '' }, att1: bob } },
      { resolveName },
    );
    expect(list.find((p) => p.email === 'alice@example.com')?.name).toBe('Contact');
    expect(list.find((p) => p.email === 'bob@example.com')?.name).toBe('Bob');
  });

  it('keeps entries without an address unmerged', () => {
    const list = getParticipantList({
      participants: {
        org,
        ghost1: { name: 'No Address', participationStatus: 'needs-action' },
        ghost2: { name: 'Also No Address', participationStatus: 'accepted' },
      },
    });
    expect(list).toHaveLength(3);
  });

  it('counts addresses, not raw entries', () => {
    expect(getParticipantCount({
      participants: {
        org: { ...org, name: '' },
        att1: bob,
        orgDup: { ...bob, name: '', email: 'alice@example.com' },
        ghost: { name: 'No Address' },
      },
    })).toBe(3);
  });
});

// The editor rebuilds the participants on every save. It used to make the
// user the organizer of every event with attendees, invitations they only
// received included, and to write their first address as
// organizerCalendarAddress - which Stalwart 1.0 also refuses on one
// occurrence of a series organized under another address or letter case.
describe('participantFieldsToSave', () => {
  const attendees = [{ name: 'Bob', email: 'bob@example.com' }];
  const owner = (fields: ReturnType<typeof participantFieldsToSave>) =>
    Object.values(fields.participants ?? {}).find((p) => p.roles?.owner);

  it('makes the user the organizer of a new event and writes the address', () => {
    const fields = participantFieldsToSave(null, attendees, {
      userEmail: 'me@example.com',
      resolveName: (email) => (email === 'me@example.com' ? 'Me' : undefined),
    });

    expect(owner(fields)).toMatchObject({ email: 'me@example.com', name: 'Me' });
    expect(fields.organizerCalendarAddress).toBe('mailto:me@example.com');
  });

  it('keeps the organizer of an invitation the user received', () => {
    const invitation: Partial<CalendarEvent> = {
      organizerCalendarAddress: 'mailto:boss@example.com',
      participants: {
        boss: { calendarAddress: 'mailto:boss@example.com', name: 'Boss' },
        me: { calendarAddress: 'mailto:me@example.com', roles: { attendee: true }, participationStatus: 'accepted' },
      },
    };
    const rows = seedAttendees(invitation, ['me@example.com']);

    const fields = participantFieldsToSave(invitation, rows, { userEmail: 'me@example.com' });

    expect(owner(fields)).toMatchObject({ email: 'boss@example.com', name: 'Boss', calendarAddress: 'mailto:boss@example.com' });
    expect(Object.values(fields.participants ?? {}).map((p) => p.email).sort()).toEqual(['boss@example.com', 'me@example.com']);
    expect(fields).not.toHaveProperty('organizerCalendarAddress');
  });

  it('keeps the exact address a series is organized under', () => {
    const series: Partial<CalendarEvent> = {
      organizerCalendarAddress: 'mailto:Team@Example.com',
      participants: { org: { calendarAddress: 'mailto:Team@Example.com' }, bob: { email: 'bob@example.com' } },
    };

    const fields = participantFieldsToSave(series, attendees, { userEmail: 'me@example.com' });

    expect(owner(fields)?.email).toBe('Team@Example.com');
    expect(fields).not.toHaveProperty('organizerCalendarAddress');
  });

  it('takes the organizer from organizerCalendarAddress when no participant names it', () => {
    const fields = participantFieldsToSave(
      { organizerCalendarAddress: 'mailto:boss@example.com', participants: {} },
      attendees,
      { userEmail: 'me@example.com' },
    );

    expect(owner(fields)?.email).toBe('boss@example.com');
    expect(fields).not.toHaveProperty('organizerCalendarAddress');
  });

  it('makes the user the organizer of an event that had none and writes the address', () => {
    const fields = participantFieldsToSave({ title: 'Lunch' }, attendees, { userEmail: 'me@example.com' });

    expect(owner(fields)?.email).toBe('me@example.com');
    expect(fields.organizerCalendarAddress).toBe('mailto:me@example.com');
  });

  it('clears the participants and the organizer when every attendee is removed', () => {
    expect(participantFieldsToSave(event, [], { userEmail: 'alice@example.com' })).toEqual({
      participants: null,
      organizerCalendarAddress: null,
    });
    expect(participantFieldsToSave(
      { participants: event.participants, replyTo: { imip: 'mailto:alice@example.com' } },
      [],
      { userEmail: 'alice@example.com' },
    )).toEqual({ participants: null, replyTo: null });
    expect(participantFieldsToSave({ title: 'Lunch' }, [], { userEmail: 'me@example.com' })).toEqual({});
  });
});
