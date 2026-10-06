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
  rsvpEvent: vi.fn(),
  supportsSyntheticCalendarIds: vi.fn(async () => false),
  queryExpandedEvents: vi.fn(),
  hydrateExpandedOccurrences: vi.fn(async (events: unknown[]) => events),
  resetSyntheticIdSupport: vi.fn(),
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
