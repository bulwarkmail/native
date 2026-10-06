import { describe, it, expect, vi, beforeEach } from 'vitest';

// The event detail sheet is opened in one account and acts later. Stalwart
// numbers ids per account, so after a switch the same id names another
// account's event: a write has to name the account it was opened in and be
// refused once that account isn't the one shown and served.

vi.mock('../../api/calendar', () => ({
  getCalendars: vi.fn(),
  queryEvents: vi.fn(),
  getEvents: vi.fn(),
  scanCalendarObjects: vi.fn(async () => []),
  isCalendarAccessDenied: vi.fn(() => false),
  noteCalendarAccessError: vi.fn(() => false),
  resetCalendarAccessDenied: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvents: vi.fn(),
  batchCreateEvents: vi.fn(),
  setDefaultCalendar: vi.fn(),
  createCalendar: vi.fn(),
  updateCalendar: vi.fn(),
  deleteCalendar: vi.fn(),
  setCalendarShare: vi.fn(),
  clearCalendarEvents: vi.fn(),
  rsvpEvent: vi.fn(),
  supportsSyntheticCalendarIds: vi.fn(async () => false),
  queryExpandedEvents: vi.fn(),
  hydrateExpandedOccurrences: vi.fn(async (events: unknown[]) => events),
  resetSyntheticIdSupport: vi.fn(),
  getParticipantIdentities: vi.fn(),
  setDefaultParticipantIdentity: vi.fn(),
}));

vi.mock('../../api/email', () => ({}));
vi.mock('../locale-store', () => ({
  t: (_key: string, fallback?: string) => fallback ?? _key,
  useLocaleStore: { getState: () => ({ locale: 'en', t: (_k: string, f?: string) => f ?? _k }) },
}));
vi.mock('../outbox-store', () => ({
  useOutboxStore: { getState: () => ({ entries: [], count: () => 0, setAccount: vi.fn(), flush: vi.fn() }) },
}));
vi.mock('../settings-store', () => ({ useSettingsStore: { getState: () => ({}) } }));
vi.mock('../offline-cache-store', () => ({ useOfflineCacheStore: { getState: () => ({}) } }));
vi.mock('../toast-store', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    isConnected: true,
    accountId: 'acc-1',
    connectionGen: 7,
    username: 'test@example.com',
    serverUrl: 'https://mail.example.com',
    getMaxObjectsInGet: () => 500,
    request: vi.fn(),
  },
}));

import * as calendarApi from '../../api/calendar';
import { useCalendarStore } from '../calendar-store';
import { useEmailStore, AccountNotServedError } from '../email-store';
import { registerServedAccount } from './helpers/served-account';

const mockUpdate = calendarApi.updateEvent as ReturnType<typeof vi.fn>;
const mockDelete = calendarApi.deleteEvents as ReturnType<typeof vi.fn>;
const mockRsvp = calendarApi.rsvpEvent as ReturnType<typeof vi.fn>;
const mockCreate = calendarApi.createEvent as ReturnType<typeof vi.fn>;
const mockGetEvents = calendarApi.getEvents as ReturnType<typeof vi.fn>;
const mockCalApi = {
  create: calendarApi.createCalendar as unknown as ReturnType<typeof vi.fn>,
  update: calendarApi.updateCalendar as unknown as ReturnType<typeof vi.fn>,
  remove: calendarApi.deleteCalendar as unknown as ReturnType<typeof vi.fn>,
  share: calendarApi.setCalendarShare as unknown as ReturnType<typeof vi.fn>,
  clear: calendarApi.clearCalendarEvents as unknown as ReturnType<typeof vi.fn>,
  setDefault: calendarApi.setDefaultCalendar as ReturnType<typeof vi.fn>,
  batchCreate: calendarApi.batchCreateEvents as ReturnType<typeof vi.fn>,
};

let A: string;
beforeEach(() => {
  vi.clearAllMocks();
  A = registerServedAccount('test@example.com', 'https://mail.example.com');
  useEmailStore.setState({ activeAccountId: A });
  useCalendarStore.setState({ calendars: [], events: [], loadedRange: null });
});

/** The app shows account B now (a notification tap), the client still serves A. */
const switchToB = () => useEmailStore.setState({ activeAccountId: 'bob@b.example.com' });
const nothingSent = () => {
  expect(mockUpdate).not.toHaveBeenCalled();
  expect(mockDelete).not.toHaveBeenCalled();
  expect(mockRsvp).not.toHaveBeenCalled();
  expect(mockCreate).not.toHaveBeenCalled();
};

describe('a detail sheet opened in A refuses to write after a switch', () => {
  it('delete', async () => {
    const account = { appAccountId: A };
    // The store was reset by the switch; B's event "1" is the one the id now names.
    switchToB();
    await expect(useCalendarStore.getState().deleteEvent('1', { account })).rejects.toThrow(AccountNotServedError);
    await expect(useCalendarStore.getState().deleteEvent('1', { account })).rejects.toThrow(/Switch back/);
    nothingSent();
  });

  it('update', async () => {
    switchToB();
    await expect(useCalendarStore.getState().updateEvent('1', { title: 'x' }, { account: { appAccountId: A } }))
      .rejects.toThrow(AccountNotServedError);
    nothingSent();
  });

  it('rsvp', async () => {
    switchToB();
    await expect(useCalendarStore.getState().rsvpEvent('1', 'p1', 'accepted', null, undefined, 'series', { appAccountId: A }))
      .rejects.toThrow(AccountNotServedError);
    nothingSent();
  });

  it('create (duplicate, new series)', async () => {
    switchToB();
    await expect(useCalendarStore.getState().createEvent({ title: 'x' }, 'cal-1', { account: { appAccountId: A } }))
      .rejects.toThrow(AccountNotServedError);
    nothingSent();
  });

  it('refuses a sheet that captured no account', async () => {
    await expect(useCalendarStore.getState().deleteEvent('1', { account: { appAccountId: null } }))
      .rejects.toThrow(AccountNotServedError);
    nothingSent();
  });
});

describe('a write from the shown account', () => {
  it('goes out on the connection it started on, in the event\'s own account', async () => {
    mockDelete.mockResolvedValue(undefined);
    await useCalendarStore.getState().deleteEvent('1', { account: { appAccountId: A } });
    expect(mockDelete).toHaveBeenCalledWith(['1'], undefined, { gen: 7, accountId: 'acc-1' });
  });

  it('with an explicit shared calendar account goes to that account', async () => {
    mockUpdate.mockResolvedValue(undefined);
    mockRsvp.mockResolvedValue(undefined);
    mockDelete.mockResolvedValue(undefined);
    const account = { appAccountId: A, jmapAccountId: 'grp-1' };
    await useCalendarStore.getState().updateEvent('1', { title: 'x' }, { account });
    await useCalendarStore.getState().rsvpEvent('1', 'p1', 'accepted', null, undefined, 'series', account);
    await useCalendarStore.getState().deleteEvent('1', { account });
    const grp = { gen: 7, accountId: 'grp-1' };
    expect(mockUpdate).toHaveBeenCalledWith('1', { title: 'x' }, undefined, grp);
    expect(mockRsvp).toHaveBeenCalledWith('1', 'p1', 'accepted', undefined, grp);
    expect(mockDelete).toHaveBeenCalledWith(['1'], undefined, grp);
  });

  it('does not touch the new account\'s events when the app switched mid-write', async () => {
    let finish!: () => void;
    mockDelete.mockReturnValue(new Promise<void>((res) => { finish = res; }));
    useCalendarStore.setState({ events: [{ id: '1' } as never] });
    const pending = useCalendarStore.getState().deleteEvent('1', { account: { appAccountId: A } });
    switchToB();
    useCalendarStore.setState({ events: [{ id: '1', title: 'bob\'s' } as never] });
    finish();
    await pending;
    expect(useCalendarStore.getState().events).toHaveLength(1);
  });
});

describe('a duplicate whose create outlives a switch', () => {
  it('reads nothing back and leaves the new account\'s events alone', async () => {
    let finish!: (e: unknown) => void;
    mockCreate.mockReturnValue(new Promise((res) => { finish = res; }));
    useCalendarStore.setState({ events: [{ id: 'b-ev' } as never] });
    const pending = useCalendarStore.getState().createEvent({ title: 'x' }, 'cal-1', { account: { appAccountId: A } });
    switchToB();
    finish({ id: '1', title: 'x' });
    await pending;
    // The re-read of id "1" would return B's event with that id.
    expect(mockGetEvents).not.toHaveBeenCalled();
    expect(useCalendarStore.getState().events).toEqual([{ id: 'b-ev' }]);
  });

  it('re-reads on the connection the create used', async () => {
    mockCreate.mockResolvedValue({ id: '1', title: 'x' });
    mockGetEvents.mockResolvedValue([]);
    await useCalendarStore.getState().createEvent({ title: 'x' }, 'cal-1', { account: { appAccountId: A } });
    expect(mockGetEvents).toHaveBeenCalledWith(['1'], { gen: 7, accountId: 'acc-1' });
  });
});

describe('one scope for a multi-step change', () => {
  it('sends every step on the scope taken at the start', async () => {
    mockUpdate.mockResolvedValue(undefined);
    const account = { appAccountId: A, scope: { gen: 3, accountId: 'acc-1' } };
    await useCalendarStore.getState().updateEvent('1', { title: 'x' }, { account });
    expect(mockUpdate).toHaveBeenCalledWith('1', { title: 'x' }, undefined, { gen: 3, accountId: 'acc-1' });
  });

  it('still refuses once another account is shown', async () => {
    switchToB();
    const account = { appAccountId: A, scope: { gen: 7, accountId: 'acc-1' } };
    await expect(useCalendarStore.getState().updateEvent('1', {}, { account })).rejects.toThrow(AccountNotServedError);
    nothingSent();
  });
});

describe('tasks, calendars and imports opened in A refuse after a switch', () => {
  const account = () => ({ appAccountId: A });

  it('tasks', async () => {
    useCalendarStore.setState({ tasks: [{ id: 't1', progress: 'needs-action' } as never] });
    switchToB();
    const st = useCalendarStore.getState();
    await expect(st.createTask({ title: 'x' }, 'cal-1', account())).rejects.toThrow(AccountNotServedError);
    await expect(st.updateTask('t1', { title: 'y' }, account())).rejects.toThrow(AccountNotServedError);
    await expect(st.toggleTaskComplete('t1', account())).rejects.toThrow(AccountNotServedError);
    await expect(st.deleteTask('t1', account())).rejects.toThrow(AccountNotServedError);
    nothingSent();
    // The optimistic tick was never applied.
    expect(useCalendarStore.getState().tasks[0].progress).toBe('needs-action');
  });

  it('calendars', async () => {
    switchToB();
    const st = useCalendarStore.getState();
    await expect(st.createCalendar('n', undefined, undefined, account())).rejects.toThrow(AccountNotServedError);
    await expect(st.updateCalendar('c', { name: 'n' }, account())).rejects.toThrow(AccountNotServedError);
    await expect(st.removeCalendar('c', account())).rejects.toThrow(AccountNotServedError);
    await expect(st.shareCalendar('c', 'p', null, account())).rejects.toThrow(AccountNotServedError);
    await expect(st.clearCalendarEvents('c', account())).rejects.toThrow(AccountNotServedError);
    await expect(st.setDefaultCalendar('c', account())).rejects.toThrow(AccountNotServedError);
    for (const m of Object.values(mockCalApi)) expect(m).not.toHaveBeenCalled();
  });

  it('an import (invitation banner)', async () => {
    switchToB();
    await expect(useCalendarStore.getState().importEvents([{ title: 'x' } as never], 'cal-1', undefined, account()))
      .rejects.toThrow(AccountNotServedError);
    expect(mockCalApi.batchCreate).not.toHaveBeenCalled();
  });

  it('from the shown account they go out on its connection', async () => {
    mockCalApi.remove.mockResolvedValue(undefined);
    mockDelete.mockResolvedValue(undefined);
    await useCalendarStore.getState().removeCalendar('c', account());
    expect(mockCalApi.remove).toHaveBeenCalledWith('c', { gen: 7, accountId: 'acc-1' });
    await useCalendarStore.getState().deleteTask('t', account());
    expect(mockDelete).toHaveBeenCalledWith(['t'], undefined, { gen: 7, accountId: 'acc-1' });
  });
});

describe('participant identities are loaded and kept per account', () => {
  const getIds = calendarApi.getParticipantIdentities as ReturnType<typeof vi.fn>;
  const setDefault = calendarApi.setDefaultParticipantIdentity as ReturnType<typeof vi.fn>;
  const list = [
    { id: 'i1', name: '', calendarAddress: 'mailto:a@example.com', isDefault: true },
    { id: 'i2', name: '', calendarAddress: 'mailto:b@example.com', isDefault: false },
  ];
  beforeEach(() => useCalendarStore.setState({ participantIdentities: {} }));

  it('stores the list under the account it was loaded for', async () => {
    getIds.mockResolvedValue(list);
    await useCalendarStore.getState().fetchParticipantIdentities({ appAccountId: A, jmapAccountId: 'acc-9' });
    expect(useCalendarStore.getState().participantIdentities).toEqual({ 'acc-9': list });
    expect(getIds).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acc-9' }));
  });

  it('drops a list that lands after the app switched account', async () => {
    getIds.mockImplementation(async () => {
      switchToB();
      return list;
    });
    await useCalendarStore.getState().fetchParticipantIdentities({ appAccountId: A, jmapAccountId: 'acc-9' });
    expect(useCalendarStore.getState().participantIdentities).toEqual({});
  });

  it('leaves the list empty when the server rejects the method', async () => {
    getIds.mockRejectedValue(new Error('unknownMethod'));
    await useCalendarStore.getState().fetchParticipantIdentities({ appAccountId: A, jmapAccountId: 'acc-9' });
    expect(useCalendarStore.getState().participantIdentities).toEqual({});
  });

  it('refuses to change the default once another account is shown', async () => {
    useCalendarStore.setState({ participantIdentities: { 'acc-9': list } });
    switchToB();
    await expect(
      useCalendarStore.getState().setDefaultParticipantIdentity('i2', { appAccountId: A, jmapAccountId: 'acc-9' }),
    ).rejects.toBeTruthy();
    expect(setDefault).not.toHaveBeenCalled();
  });

  it('flags the new default in that account only', async () => {
    const other = [{ id: 'z', name: '', calendarAddress: 'mailto:z@example.com', isDefault: true }];
    useCalendarStore.setState({ participantIdentities: { 'acc-9': list, 'acc-8': other } });
    setDefault.mockResolvedValue(undefined);
    await useCalendarStore.getState().setDefaultParticipantIdentity('i2', { appAccountId: A, jmapAccountId: 'acc-9' });
    const state = useCalendarStore.getState().participantIdentities;
    expect(state['acc-9'].map((i) => i.isDefault)).toEqual([false, true]);
    expect(state['acc-8']).toEqual(other);
  });

  it('is cleared when the store resets for an account change', () => {
    useCalendarStore.setState({ participantIdentities: { 'acc-9': list } });
    useCalendarStore.getState().reset();
    expect(useCalendarStore.getState().participantIdentities).toEqual({});
  });
});

describe('a note is private: no scheduling mail', () => {
  it('a note on an event with participants sends no scheduling flag', async () => {
    const { buildNoteUpdate, noteSaveOptions } = await import('../../lib/event-note');
    mockUpdate.mockResolvedValue(undefined);
    const event = {
      id: '1',
      description: 'Agenda',
      participants: {
        me: { email: 'test@example.com', roles: { owner: true } },
        guest: { email: 'guest@example.com', roles: { attendee: true } },
      },
    };
    useCalendarStore.setState({ events: [event as never] });
    const updates = buildNoteUpdate(event, 'remember the slides', new Date(2026, 9, 6, 9, 30))!;
    await useCalendarStore.getState().updateEvent('1', updates, noteSaveOptions({ appAccountId: A }));
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const [, patch, schedule] = mockUpdate.mock.calls[0];
    expect(patch).toEqual({ description: 'Agenda\n\n--- 2026-10-06 09:30 ---\nremember the slides' });
    expect(schedule).toBe(false);
  });
});
