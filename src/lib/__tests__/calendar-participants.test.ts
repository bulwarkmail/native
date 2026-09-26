import { describe, it, expect } from 'vitest';
import type { CalendarEvent } from '../../api/types';
import {
  askAttendeesAgain,
  buildParticipantMap,
  collectUserCalendarAddresses,
  getParticipantCount,
  getParticipantList,
  getStatusCounts,
  getUserParticipantId,
  hasAnsweredAttendees,
  isOrganizer,
  participantFieldsToSave,
  participantLimitMessage,
  participantLimitOf,
  seedAttendees,
  seriesParticipantFields,
  userOrganizes,
} from '../calendar-participants';
import { JMAPSetError } from '../../api/jmap-result';

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
    const rows = [...seedAttendees(invitation, ['me@example.com']), { name: 'Dan', email: 'dan@example.com' }];

    const fields = participantFieldsToSave(invitation, rows, { userEmail: 'me@example.com' });

    expect(owner(fields)).toMatchObject({ email: 'boss@example.com', name: 'Boss', calendarAddress: 'mailto:boss@example.com' });
    expect(Object.values(fields.participants ?? {}).map((p) => p.email).sort())
      .toEqual(['boss@example.com', 'dan@example.com', 'me@example.com']);
    expect(fields).not.toHaveProperty('organizerCalendarAddress');
  });

  it('writes no participants for an invitation whose list the user left alone', () => {
    // An alert or a note on the user's copy: a written list would reach the
    // organizer as a reply.
    const invitation: Partial<CalendarEvent> = {
      organizerCalendarAddress: 'mailto:boss@example.com',
      participants: {
        boss: { calendarAddress: 'mailto:boss@example.com', roles: { owner: true } },
        me: { calendarAddress: 'mailto:me@example.com', roles: { attendee: true }, participationStatus: 'accepted' },
        bob: { calendarAddress: 'mailto:bob@example.com', roles: { attendee: true }, participationStatus: 'declined' },
      },
    };

    const fields = participantFieldsToSave(invitation, seedAttendees(invitation, ['me@example.com']), {
      userEmail: 'me@example.com',
      rescheduled: true,
    });

    expect(fields).toEqual({});
  });

  it('keeps the exact address a series is organized under', () => {
    const series: Partial<CalendarEvent> = {
      organizerCalendarAddress: 'mailto:Team@Example.com',
      participants: { org: { calendarAddress: 'mailto:Team@Example.com' }, bob: { email: 'bob@example.com' } },
    };

    // The user organizes it under a group address in another letter case.
    const fields = participantFieldsToSave(series, [...attendees, { name: 'Dan', email: 'dan@example.com' }], {
      userEmail: 'me@example.com',
      userEmails: ['me@example.com', 'team@example.com'],
    });

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

describe('answers on save (Stalwart 0.16 and 1.0)', () => {
  // A meeting the user organizes: Bob accepted, Carol declined, Dan never answered.
  const meeting: Partial<CalendarEvent> = {
    organizerCalendarAddress: 'mailto:me@example.com',
    participants: {
      p0: { calendarAddress: 'mailto:me@example.com', roles: { owner: true }, participationStatus: 'accepted' },
      p1: { calendarAddress: 'mailto:Bob@example.com', roles: { attendee: true }, participationStatus: 'accepted' },
      p2: { calendarAddress: 'mailto:carol@example.com', roles: { attendee: true }, participationStatus: 'declined' },
      p3: { calendarAddress: 'mailto:dan@example.com', roles: { attendee: true }, participationStatus: 'needs-action' },
    },
  };
  const me = { userEmail: 'me@example.com', userEmails: ['me@example.com'] };
  const rows = () => seedAttendees(meeting, ['me@example.com']);
  const byAddress = (fields: ReturnType<typeof participantFieldsToSave>) => Object.fromEntries(
    Object.entries(fields.participants ?? {}).map(([id, p]) => [p.email!.toLowerCase(), { id, status: p.participationStatus }]),
  );

  it('keeps every attendee\'s id and answer, and asks a new one', () => {
    const fields = participantFieldsToSave(meeting, [...rows(), { name: 'Eve', email: 'eve@example.com' }], me);

    const after = byAddress(fields);
    expect(after['me@example.com']).toEqual({ id: 'p0', status: 'accepted' });
    expect(after['bob@example.com']).toEqual({ id: 'p1', status: 'accepted' });
    expect(after['carol@example.com']).toEqual({ id: 'p2', status: 'declined' });
    expect(after['dan@example.com']).toEqual({ id: 'p3', status: 'needs-action' });
    expect(after['eve@example.com'].status).toBe('needs-action');
    expect(after['eve@example.com'].id).not.toMatch(/^p\d$/);
  });

  it('asks the attendees again when the user as the organizer moves the meeting', () => {
    const after = byAddress(participantFieldsToSave(meeting, rows(), { ...me, rescheduled: true }));

    expect(after['me@example.com'].status).toBe('accepted');
    expect(after['bob@example.com']).toEqual({ id: 'p1', status: 'needs-action' });
    expect(after['carol@example.com']).toEqual({ id: 'p2', status: 'needs-action' });
  });

  it('counts any of the user\'s addresses as the organizer', () => {
    const aliasMeeting = { ...meeting, organizerCalendarAddress: 'mailto:Alias@example.com' } as Partial<CalendarEvent>;
    aliasMeeting.participants = { ...meeting.participants, p0: { ...meeting.participants!.p0, calendarAddress: 'mailto:Alias@example.com' } };

    const after = byAddress(participantFieldsToSave(aliasMeeting, seedAttendees(aliasMeeting, ['me@example.com', 'alias@example.com']), {
      userEmail: 'me@example.com', userEmails: ['me@example.com', 'alias@example.com'], rescheduled: true,
    }));

    expect(after['bob@example.com'].status).toBe('needs-action');
    expect(userOrganizes(aliasMeeting, ['me@example.com', 'ALIAS@example.com'])).toBe(true);
    expect(userOrganizes(aliasMeeting, ['me@example.com'])).toBe(false);
  });

  it('keeps an answer listed under a second entry of the same address', () => {
    const map = buildParticipantMap({ name: '', email: 'me@example.com' }, [{ name: '', email: 'bob@example.com' }], {
      a: { calendarAddress: 'mailto:bob@example.com', participationStatus: 'needs-action' },
      b: { email: 'BOB@example.com', participationStatus: 'tentative' },
    });

    expect(Object.entries(map).find(([, p]) => p.email === 'bob@example.com')).toEqual([
      'a', expect.objectContaining({ participationStatus: 'tentative' }),
    ]);
  });

  it('tells whether anyone but the organizer answered', () => {
    expect(hasAnsweredAttendees(meeting.participants)).toBe(true);
    expect(hasAnsweredAttendees(askAttendeesAgain(meeting.participants!))).toBe(false);
    expect(hasAnsweredAttendees(null)).toBe(false);
  });

  it('asks everyone but the organizer again for a new series', () => {
    const asked = askAttendeesAgain(meeting.participants!, ['me@example.com']);

    expect(asked.p0.participationStatus).toBe('accepted');
    expect([asked.p1, asked.p2, asked.p3].map((p) => p.participationStatus)).toEqual(['needs-action', 'needs-action', 'needs-action']);
  });
});

describe('seriesParticipantFields (all occurrences)', () => {
  const master: Partial<CalendarEvent> = {
    organizerCalendarAddress: 'mailto:me@example.com',
    participants: {
      p0: { calendarAddress: 'mailto:me@example.com', roles: { owner: true }, participationStatus: 'accepted' },
      p1: { calendarAddress: 'mailto:bob@example.com', roles: { attendee: true }, participationStatus: 'accepted' },
      p2: { calendarAddress: 'mailto:carol@example.com', roles: { attendee: true }, participationStatus: 'tentative' },
    },
  };
  // This occurrence: Bob declined it, and Zoe was added to just this day.
  const occurrence: Partial<CalendarEvent> = {
    ...master,
    participants: {
      ...master.participants,
      p1: { ...master.participants!.p1, participationStatus: 'declined' },
      pz: { calendarAddress: 'mailto:zoe@example.com', roles: { attendee: true }, participationStatus: 'accepted' },
    },
  };
  const me = { userEmail: 'me@example.com', userEmails: ['me@example.com'] };
  const rows = seedAttendees(occurrence, ['me@example.com']);
  const statuses = (fields: ReturnType<typeof seriesParticipantFields>) => Object.fromEntries(
    Object.values(fields.participants ?? {}).map((p) => [p.email, p.participationStatus]),
  );

  it('writes nothing when the user changed no attendee and did not move the series', () => {
    expect(seriesParticipantFields(master, occurrence, rows, me)).toEqual({});
  });

  it('starts from the series\' own list and applies only the attendees added or removed', () => {
    const edited = [...rows.filter((a) => a.email !== 'carol@example.com'), { name: '', email: 'eve@example.com' }];

    const fields = seriesParticipantFields(master, occurrence, edited, me);

    // Bob keeps the series' answer, not this day's; Zoe stays on her day only.
    expect(statuses(fields)).toEqual({
      'me@example.com': 'accepted',
      'bob@example.com': 'accepted',
      'eve@example.com': 'needs-action',
    });
  });

  it('asks the series\' attendees again when the user moves it', () => {
    const fields = seriesParticipantFields(master, occurrence, rows, { ...me, rescheduled: true });

    expect(statuses(fields)).toEqual({
      'me@example.com': 'accepted',
      'bob@example.com': 'needs-action',
      'carol@example.com': 'needs-action',
    });
  });
});

// userc shares a calendar with the user (userb, read & write) and organizes a
// meeting in it; userb attends it too. Stalwart sends a change to it from
// userc, the owner of the account the event is in, and says so with
// `isOrigin` - true for that meeting and each expanded occurrence, false for
// an invitation userc got (live on 1.0 and 0.16.23). The app took userb for
// an attendee there: the editor wrote no participants and sent nothing, and
// a move asked nobody again.
describe.each(['0.16.23', '1.0'])('the owner\'s meeting in a calendar shared with the user on Stalwart %s', (version) => {
  const ME = 'userb@example.org';
  // 0.16.23 drops an attendee's roles; 1.0 keeps them.
  const attendee = (address: string, participationStatus: string) => ({
    calendarAddress: `mailto:${address}`, participationStatus,
    ...(version === '1.0' ? { roles: { attendee: true } } : {}),
  });
  const inShared = (organizer: string, isOrigin: boolean): Partial<CalendarEvent> => ({
    id: 'f:fj', accountId: 'f', isShared: true, isOrigin,
    organizerCalendarAddress: `mailto:${organizer}`,
    participants: {
      owner: { calendarAddress: `mailto:${organizer}`, roles: { owner: true }, participationStatus: 'accepted' },
      anna: attendee('usera@example.org', 'accepted'),
      bea: attendee(ME, 'tentative'),
    },
  } as Partial<CalendarEvent>);
  const me = { userEmail: ME, userEmails: [ME] };
  const statuses = (fields: ReturnType<typeof participantFieldsToSave>) => Object.fromEntries(
    Object.entries(fields.participants ?? {}).map(([id, p]) => [id, p.participationStatus]),
  );

  it('is the owner\'s to change: the server schedules it from the owner', () => {
    expect(userOrganizes(inShared('userc@example.org', true), [ME])).toBe(true);
    expect(userOrganizes(inShared('usera@example.org', false), [ME])).toBe(false);
  });

  it('keeps the user on the list they open, and writes the owner\'s participants', () => {
    const meeting = inShared('userc@example.org', true);
    const rows = seedAttendees(meeting, [ME]);

    expect(rows.map((a) => a.email)).toEqual(['usera@example.org', ME]);
    const fields = participantFieldsToSave(meeting, rows, me);
    expect(fields.participants?.owner).toMatchObject({ calendarAddress: 'mailto:userc@example.org', roles: { owner: true } });
    expect(statuses(fields)).toEqual({ owner: 'accepted', anna: 'accepted', bea: 'tentative' });
    expect(fields).not.toHaveProperty('organizerCalendarAddress');
  });

  it('asks the attendees again when the user moves it', () => {
    const meeting = inShared('userc@example.org', true);

    const fields = participantFieldsToSave(meeting, seedAttendees(meeting, [ME]), { ...me, rescheduled: true });

    expect(statuses(fields)).toEqual({ owner: 'accepted', anna: 'needs-action', bea: 'needs-action' });
  });

  it('leaves an invitation the owner got alone', () => {
    const invitation = inShared('boss@example.org', false);

    expect(participantFieldsToSave(invitation, seedAttendees(invitation, [ME]), { ...me, rescheduled: true })).toEqual({});
  });

  it('asks the series\' attendees again when the user moves every occurrence', () => {
    const meeting = inShared('userc@example.org', true);

    const fields = seriesParticipantFields(meeting, meeting, seedAttendees(meeting, [ME]), { ...me, rescheduled: true });

    expect(statuses(fields)).toEqual({ owner: 'accepted', anna: 'needs-action', bea: 'needs-action' });
  });
});

describe('seedAttendees for a meeting organized under an alias', () => {
  // The user organizes under alias@ and invited their own main address too:
  // only the organizer's entry is left out, not the user's main address.
  it('keeps the user\'s main address on the list', () => {
    const meeting: Partial<CalendarEvent> = {
      organizerCalendarAddress: 'mailto:alias@example.com',
      participants: {
        org: { calendarAddress: 'mailto:alias@example.com', roles: { owner: true }, participationStatus: 'accepted' },
        main: { calendarAddress: 'mailto:me@example.com', roles: { attendee: true }, participationStatus: 'accepted' },
        bob: { calendarAddress: 'mailto:bob@example.com', roles: { attendee: true } },
      },
    };

    expect(seedAttendees(meeting, ['me@example.com', 'alias@example.com']).map((a) => a.email))
      .toEqual(['me@example.com', 'bob@example.com']);
  });

  it('leaves the user out of an event that names no organizer: they become it on save', () => {
    const plain: Partial<CalendarEvent> = {
      participants: {
        a: { calendarAddress: 'mailto:me@example.com' },
        b: { calendarAddress: 'mailto:bob@example.com' },
      },
    };

    expect(seedAttendees(plain, ['me@example.com']).map((a) => a.email)).toEqual(['bob@example.com']);
  });
});

describe('participantLimitOf (Stalwart 1.0 maxParticipantsPerEvent)', () => {
  it('reads the limit from a 1.0 refusal and ignores other failures', () => {
    const refusal = new JMAPSetError('invalidProperties', 'An event cannot have more than 20 participants.', ['participants']);

    expect(participantLimitOf(refusal)).toBe(20);
    expect(participantLimitOf(new Error('Failed to create event'))).toBeNull();
    expect(participantLimitOf(null)).toBeNull();
    // An import that got nothing in carries the refusals as reasons.
    expect(participantLimitOf(Object.assign(new Error('nothing imported'), {
      refused: [{ reason: 'An event cannot have more than 5 participants.' }],
    }))).toBe(5);
  });

  it('says the limit, counting the organizer, in the user\'s language', () => {
    const t = (_key: string, fallback?: string, params?: Record<string, unknown>) =>
      (fallback ?? '').replace('{max, plural, one {# participant} other {# participants}}', `${params?.max} participants`);

    expect(participantLimitMessage(new Error('An event cannot have more than 20 participants.'), t))
      .toBe('The server allows at most 20 participants per event, including the organizer, so it refused this change. An administrator can raise the limit.');
    expect(participantLimitMessage(new Error('nope'), t)).toBeNull();
  });
});
