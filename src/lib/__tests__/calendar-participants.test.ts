import { describe, it, expect } from 'vitest';
import type { CalendarEvent } from '../../api/types';
import {
  buildParticipantMap,
  collectUserCalendarAddresses,
  getParticipantCount,
  getParticipantList,
  getStatusCounts,
  getUserParticipantId,
  isDeclinedByUser,
  isInactiveEvent,
  isOrganizer,
  seedAttendees,
  defaultIdentityAddress,
  organizerAddressForSave,
  newInvitationOrganizer,
  participantsLockedFor,
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
  it('omits a blank organizer name', () => {
    const map = buildParticipantMap({ name: '', email: 'me@x.example' }, []);
    const [org] = Object.values(map);
    expect(org.email).toBe('me@x.example');
    expect('name' in org).toBe(false);
  });

  it('omits a whitespace-only attendee name and trims a real one', () => {
    const map = buildParticipantMap({ name: 'Me', email: 'me@x.example' }, [
      { name: '   ', email: 'a@x.example' },
      { name: ' Ann ', email: 'b@x.example' },
    ]);
    const byEmail = Object.fromEntries(Object.values(map).map((p) => [p.email, p]));
    expect('name' in byEmail['a@x.example']).toBe(false);
    expect(byEmail['b@x.example'].name).toBe('Ann');
  });

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

describe('isDeclinedByUser / isInactiveEvent', () => {
  const declined: Partial<CalendarEvent> = {
    participants: {
      org: { email: 'alice@example.com', roles: { owner: true } },
      dave: { calendarAddress: 'mailto:dave@example.com', roles: { attendee: true }, participationStatus: 'declined' },
      bob: { email: 'bob@example.com', roles: { attendee: true }, participationStatus: 'accepted' },
    },
  };

  it('matches any of the user addresses, case-insensitively', () => {
    expect(isDeclinedByUser(declined, ['Dave@Example.com'])).toBe(true);
    expect(isDeclinedByUser(declined, ['alias@example.com', 'dave@example.com'])).toBe(true);
    expect(isDeclinedByUser(declined, ['bob@example.com'])).toBe(false);
  });

  it('is false without addresses or participants', () => {
    expect(isDeclinedByUser(declined, [])).toBe(false);
    expect(isDeclinedByUser(declined, undefined)).toBe(false);
    expect(isDeclinedByUser({}, ['dave@example.com'])).toBe(false);
  });

  it('counts cancelled events as inactive too', () => {
    expect(isInactiveEvent({ status: 'cancelled' }, undefined)).toBe(true);
    expect(isInactiveEvent(declined, ['dave@example.com'])).toBe(true);
    expect(isInactiveEvent({ ...declined, status: 'confirmed' }, ['bob@example.com'])).toBe(false);
  });
});

describe('organizerAddressForSave', () => {
  const identities = [
    { calendarAddress: 'mailto:me@example.com', isDefault: false },
    { calendarAddress: 'mailto:Work@example.com', isDefault: true },
  ];

  it('reads the default identity without its mailto: scheme', () => {
    expect(defaultIdentityAddress(identities)).toBe('Work@example.com');
    expect(defaultIdentityAddress([])).toBe('');
    expect(defaultIdentityAddress(undefined)).toBe('');
  });

  it('organizes a new event as the default identity', () => {
    expect(organizerAddressForSave(null, identities, ['login@example.com'])).toBe('Work@example.com');
  });

  it('organizes an event gaining participants as the default identity', () => {
    expect(organizerAddressForSave({ title: 'Solo' }, identities, ['login@example.com'])).toBe('Work@example.com');
  });

  it('keeps the organizer an existing event already has', () => {
    expect(
      organizerAddressForSave({ organizerCalendarAddress: 'mailto:old@example.com' }, identities, ['login@example.com']),
    ).toBe('old@example.com');
  });

  it('falls back to the first login address with no identity (no capability)', () => {
    expect(organizerAddressForSave(null, undefined, ['login@example.com', 'x@example.com'])).toBe('login@example.com');
    expect(organizerAddressForSave(null, [{ calendarAddress: 'mailto:a@b.c', isDefault: false }], ['login@example.com'])).toBe('login@example.com');
    expect(organizerAddressForSave(null, [], [])).toBe('');
  });
});

describe('newInvitationOrganizer (the settings select and the save agree)', () => {
  const login = ['login@example.com'];

  it('is the flagged default identity, by id and address', () => {
    const ids = [
      { id: 'a', calendarAddress: 'mailto:login@example.com', isDefault: false },
      { id: 'b', calendarAddress: 'mailto:Work@example.com', isDefault: true },
    ];
    expect(newInvitationOrganizer(ids, login)).toEqual({ address: 'Work@example.com', identityId: 'b' });
  });

  it('without a default is the login address, and the identity that has it', () => {
    const ids = [
      { id: 'a', calendarAddress: 'mailto:other@example.com', isDefault: false },
      { id: 'b', calendarAddress: 'mailto:LOGIN@example.com', isDefault: false },
    ];
    expect(newInvitationOrganizer(ids, login)).toEqual({ address: 'login@example.com', identityId: 'b' });
  });

  it('names no identity when the login address is none of them (not the first one)', () => {
    const ids = [
      { id: 'a', calendarAddress: 'mailto:other@example.com', isDefault: false },
      { id: 'b', calendarAddress: 'mailto:more@example.com', isDefault: false },
    ];
    expect(newInvitationOrganizer(ids, login)).toEqual({ address: 'login@example.com', identityId: null });
  });

  it('skips a default without an address, like the save', () => {
    const ids = [
      { id: 'a', calendarAddress: '  ', isDefault: true },
      { id: 'b', calendarAddress: 'mailto:login@example.com', isDefault: false },
    ];
    expect(newInvitationOrganizer(ids, login)).toEqual({ address: 'login@example.com', identityId: 'b' });
  });

  it('is what a new event is saved with', () => {
    const cases = [
      [{ id: 'a', calendarAddress: 'mailto:other@example.com', isDefault: false }],
      [{ id: 'a', calendarAddress: 'mailto:w@example.com', isDefault: true }],
      [],
    ];
    for (const ids of cases) {
      expect(organizerAddressForSave(null, ids, login)).toBe(newInvitationOrganizer(ids, login).address);
    }
  });
});

describe('editing keeps participants', () => {
  const existing = {
    o1: { '@type': 'Participant', email: 'work@example.com', calendarAddress: 'mailto:work@example.com', roles: { owner: true }, participationStatus: 'accepted', extra: 'keep' },
    p1: { '@type': 'Participant', email: 'bob@example.com', name: 'Bob', roles: { attendee: true }, participationStatus: 'declined', scheduleStatus: '2.0' },
    p2: { '@type': 'Participant', email: 'gone@example.com', roles: { attendee: true } },
  } as unknown as Record<string, import('../../api/types').Participant>;

  it('keeps ids and properties, drops removed, adds new with fresh ids', () => {
    const map = buildParticipantMap(
      { name: 'W', email: 'Work@example.com' },
      [{ name: 'Bob', email: 'bob@example.com' }, { name: 'Cy', email: 'cy@example.com' }],
      existing,
    );
    expect(map.o1).toBe(existing.o1);
    expect(map.p1).toBe(existing.p1);
    expect(map.p2).toBeUndefined();
    const added = Object.entries(map).filter(([id]) => !(id in existing));
    expect(added).toHaveLength(1);
    expect(added[0][1].email).toBe('cy@example.com');
    expect(Object.keys(map)).toHaveLength(3);
  });

  it('seedAttendees leaves out the organizer address actually used', () => {
    const ev = { participants: { a: { email: 'work@example.com', roles: {} }, b: { email: 'bob@example.com', roles: { attendee: true } } } } as unknown as Partial<CalendarEvent>;
    expect(seedAttendees(ev, ['me@example.com'], 'mailto:Work@example.com').map((a) => a.email)).toEqual(['bob@example.com']);
  });
});

describe('participantsLockedFor', () => {
  const ev = { organizerCalendarAddress: 'mailto:Work@example.com', participants: { a: { email: 'bob@example.com' } } } as unknown as Partial<CalendarEvent>;
  it('is open to the organizer, also as an identity address', () => {
    expect(participantsLockedFor(ev, ['me@example.com', 'work@example.com'])).toBe(false);
  });
  it('is locked for someone else\'s event', () => {
    expect(participantsLockedFor(ev, ['me@example.com'])).toBe(true);
  });
  it('is open for events without participants and for new ones', () => {
    expect(participantsLockedFor({ title: 'x' }, ['me@example.com'])).toBe(false);
    expect(participantsLockedFor(null, [])).toBe(false);
  });
});
