import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/share-notifications', () => ({
  getShareNotifications: vi.fn(),
  destroyShareNotifications: vi.fn(),
}));
vi.mock('../../api/calendar-event-notifications', () => ({
  getCalendarEventNotifications: vi.fn(),
  destroyCalendarEventNotifications: vi.fn(),
}));
const client = vi.hoisted(() => ({
  accountId: 'acc-1', isConnected: true, username: 'u1', serverUrl: 'https://a.example/',
}));
const accounts = vi.hoisted(() => ({ active: 'app-1' }));
vi.mock('../account-store', () => ({
  useAccountStore: {
    getState: () => ({
      activeAccountId: accounts.active,
      getAccountById: (id: string) =>
        ({ 'app-1': { username: 'u1', serverUrl: 'https://a.example' }, 'app-2': { username: 'u2', serverUrl: 'https://b.example' } } as Record<string, unknown>)[id],
    }),
  },
}));
vi.mock('../../api/jmap-client', () => ({ jmapClient: client }));

import { getShareNotifications, destroyShareNotifications } from '../../api/share-notifications';
import { getCalendarEventNotifications } from '../../api/calendar-event-notifications';
import { useShareNotificationStore as useStore } from '../share-notification-store';
import { useCalendarEventNotificationStore } from '../calendar-event-notification-store';
import { resetPendingNotificationStores } from '../pending-notification-store';

const mockList = getShareNotifications as ReturnType<typeof vi.fn>;
const mockDestroy = destroyShareNotifications as ReturnType<typeof vi.fn>;
const mockCalendarList = getCalendarEventNotifications as ReturnType<typeof vi.fn>;

const n = (id: string) => ({
  id, created: '', changedBy: { name: 'A', email: 'a@x', principalId: null },
  objectType: 'Calendar', objectAccountId: 'o', objectId: 'c' + id, oldRights: null, newRights: { mayReadItems: true }, name: 'C',
});
const ids = () => useStore.getState().pending.map((p) => p.id);

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  client.accountId = 'acc-1';
  client.username = 'u1';
  client.serverUrl = 'https://a.example/';
  accounts.active = 'app-1';
  useStore.getState().reset();
  // reset() keeps the seen set; fresh ids per test.
});

describe('share notification store', () => {
  it('tags notices with their app account and drops a fetch that lands after a switch', async () => {
    mockList.mockResolvedValue([n('t1')]);
    await useStore.getState().fetch();
    expect(useStore.getState().pending).toEqual([expect.objectContaining({ id: 't1', accountId: 'acc-1', appAccountId: 'app-1' })]);

    const d = deferred<unknown[]>();
    mockList.mockReturnValue(d.promise);
    const p = useStore.getState().fetch();
    useStore.getState().reset();
    accounts.active = 'app-2'; client.username = 'u2'; client.serverUrl = 'https://b.example';
    d.resolve([n('t2')]);
    await p;
    expect(ids()).toEqual([]);
    // Not marked seen: once settled on app-2 it shows, tagged for app-2.
    mockList.mockResolvedValue([n('t2')]);
    await useStore.getState().fetch();
    expect(useStore.getState().pending).toEqual([expect.objectContaining({ id: 't2', appAccountId: 'app-2' })]);
  });

  it('never destroys account A\'s notices while the client serves account B with the same JMAP id', async () => {
    client.accountId = 'b';
    mockList.mockResolvedValue([n('g1')]);
    await useStore.getState().fetch();
    let guard: (() => boolean) | undefined;
    mockDestroy.mockImplementation(async (_ids: string[], _acc: string, g?: () => boolean) => { guard = g; });
    await useStore.getState().acknowledge(['g1']);
    expect(mockDestroy).toHaveBeenCalledWith(['g1'], 'b', expect.any(Function));
    expect(guard!()).toBe(true);
    accounts.active = 'app-2'; client.username = 'u2'; client.serverUrl = 'https://b.example';
    expect(guard!()).toBe(false);
    accounts.active = 'app-1';
    expect(guard!()).toBe(false);
  });

  it('does not toast the same notice twice in a session after reset', async () => {
    mockList.mockResolvedValue([n('k1')]);
    await useStore.getState().fetch();
    await useStore.getState().acknowledge(['k1']);
    useStore.getState().reset();
    await useStore.getState().fetch();
    expect(ids()).toEqual([]);
    // Another app account with the same JMAP and notice ids still sees its own.
    useStore.getState().reset();
    accounts.active = 'app-2'; client.username = 'u2'; client.serverUrl = 'https://b.example';
    await useStore.getState().fetch();
    expect(ids()).toEqual(['k1']);
  });

  it('coalesces fetches in flight', async () => {
    const d = deferred<unknown[]>();
    mockList.mockReturnValue(d.promise);
    const a = useStore.getState().fetch();
    const b = useStore.getState().fetch();
    d.resolve([n('c1')]);
    await Promise.all([a, b]);
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(ids()).toEqual(['c1']);
  });

  it('resetPendingNotificationStores empties this store and the calendar one', async () => {
    mockList.mockResolvedValue([n('r1')]);
    mockCalendarList.mockResolvedValue([{ id: 'cal-r1', type: 'created', isDraft: false }]);
    await useStore.getState().fetch();
    await useCalendarEventNotificationStore.getState().fetch();
    expect(ids()).toEqual(['r1']);
    expect(useCalendarEventNotificationStore.getState().pending).toHaveLength(1);
    resetPendingNotificationStores();
    expect(ids()).toEqual([]);
    expect(useCalendarEventNotificationStore.getState().pending).toEqual([]);
  });
});
