import { describe, it, expect, vi, beforeEach } from 'vitest';

// The invitation banner's Accept / Add: the import, the look-up of the
// imported event and the answer are one change, sent on one connection taken
// when the user taps, never three scopes taken at three moments.

const h = vi.hoisted(() => ({ gen: 7 }));
vi.mock('../../stores/email-store', () => ({
  requireShownAccountScope: vi.fn(() => ({ gen: h.gen++, accountId: 'acc-1' })),
}));

import { requireShownAccountScope } from '../../stores/email-store';
import { importInvitation, importAndRespond, InvitationUidConflictError } from '../invitation-actions';

const mockScope = requireShownAccountScope as unknown as ReturnType<typeof vi.fn>;
const invite = {
  uid: 'u1',
  title: 'Review',
  participants: { me: { email: 'me@example.com', roles: { attendee: true } } },
} as never;
const stored = {
  id: '42',
  uid: 'u1',
  participants: { p9: { email: 'me@example.com', roles: { attendee: true } } },
} as never;

function actions() {
  return {
    importEvents: vi.fn(async () => ({ imported: 1, refused: [] })),
    findEventsByUid: vi.fn(async () => [stored]),
    rsvpEvent: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.gen = 7;
});

describe('importAndRespond', () => {
  it('imports, looks up and answers on the one scope taken at the start', async () => {
    const a = actions();
    a.findEventsByUid.mockResolvedValueOnce([]);
    const found = vi.fn();
    await importAndRespond({
      event: invite, existing: null, calendarId: 'cal-1', status: 'accepted',
      userEmails: ['me@example.com'], replyTo: null, appAccountId: 'app-1', actions: a, onFound: found,
    });
    expect(mockScope).toHaveBeenCalledTimes(1);
    expect(mockScope).toHaveBeenCalledWith('app-1');
    const scope = { gen: 7, accountId: 'acc-1' };
    expect(a.importEvents).toHaveBeenCalledWith([invite], 'cal-1', undefined, { appAccountId: 'app-1', scope });
    expect(a.findEventsByUid).toHaveBeenCalledWith('u1', scope);
    expect(found).toHaveBeenCalledWith(stored);
    expect(a.rsvpEvent).toHaveBeenCalledWith('42', 'p9', 'accepted', null, stored, 'series', {
      appAccountId: 'app-1', jmapAccountId: undefined, scope,
    });
  });

  it('answers an event already there without importing it', async () => {
    const a = actions();
    await importAndRespond({
      event: invite, existing: { ...(stored as object), accountId: 'grp' } as never, calendarId: 'cal-1',
      status: 'declined', userEmails: ['me@example.com'], replyTo: null, appAccountId: 'app-1', actions: a,
    });
    expect(a.importEvents).not.toHaveBeenCalled();
    expect((a.rsvpEvent.mock.calls[0] as unknown[])[6]).toEqual({
      appAccountId: 'app-1', jmapAccountId: 'grp', scope: { gen: 7, accountId: 'acc-1' },
    });
  });

  it('sends nothing when the account is not served', async () => {
    mockScope.mockImplementationOnce(() => { throw new Error('Switch back'); });
    const a = actions();
    await expect(importAndRespond({
      event: invite, existing: null, calendarId: 'cal-1', status: 'accepted',
      userEmails: ['me@example.com'], replyTo: null, appAccountId: 'app-1', actions: a,
    })).rejects.toThrow('Switch back');
    expect(a.importEvents).not.toHaveBeenCalled();
    expect(a.rsvpEvent).not.toHaveBeenCalled();
  });

  it('never claims an answer when no event to answer was found', async () => {
    const a = actions();
    a.findEventsByUid.mockResolvedValue([]);
    await expect(importAndRespond({
      event: invite, existing: null, calendarId: 'cal-1', status: 'accepted',
      userEmails: ['me@example.com'], replyTo: null, appAccountId: 'app-1', actions: a,
    })).rejects.toThrow('No event to respond to');
    expect(a.rsvpEvent).not.toHaveBeenCalled();
  });
});

describe('importInvitation', () => {
  it('imports on a scope taken at the start', async () => {
    const a = actions();
    expect(await importInvitation(invite, 'cal-1', 'app-1', a)).toEqual({ imported: 1, refused: [] });
    expect(a.findEventsByUid).toHaveBeenCalledWith('u1', { gen: 7, accountId: 'acc-1' });
    expect(a.importEvents).toHaveBeenCalledWith([invite], 'cal-1', undefined, {
      appAccountId: 'app-1', scope: { gen: 7, accountId: 'acc-1' },
    });
  });
});

describe('an invitation carrying the UID of an unrelated event', () => {
  // Same UID, another organizer: the user's own event, not the invitation's.
  const unrelated = { ...(stored as object), organizerCalendarAddress: 'mailto:boss@example.com' } as never;
  const crafted = { ...(invite as object), organizerCalendarAddress: 'mailto:mallory@evil.com' } as never;

  it('does not answer the unrelated event', async () => {
    const a = actions();
    a.findEventsByUid.mockResolvedValue([unrelated]);
    await expect(importAndRespond({
      event: crafted, existing: null, calendarId: 'cal-1', status: 'accepted',
      userEmails: ['me@example.com'], replyTo: null, appAccountId: 'app-1', actions: a,
    })).rejects.toBeInstanceOf(InvitationUidConflictError);
    await expect(importAndRespond({
      event: crafted, existing: unrelated, calendarId: 'cal-1', status: 'accepted',
      userEmails: ['me@example.com'], replyTo: null, appAccountId: 'app-1', actions: a,
    })).rejects.toBeInstanceOf(InvitationUidConflictError);
    expect(a.importEvents).not.toHaveBeenCalled();
    expect(a.rsvpEvent).not.toHaveBeenCalled();
  });

  it('does not import it (which would link the unrelated event)', async () => {
    const a = actions();
    a.findEventsByUid.mockResolvedValue([unrelated]);
    await expect(importInvitation(crafted, 'cal-1', 'app-1', a)).rejects.toBeInstanceOf(InvitationUidConflictError);
    expect(a.importEvents).not.toHaveBeenCalled();
  });
});
