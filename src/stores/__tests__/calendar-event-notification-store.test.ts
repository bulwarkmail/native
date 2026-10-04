import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/calendar-event-notifications', () => ({
  getCalendarEventNotifications: vi.fn(),
  destroyCalendarEventNotifications: vi.fn(),
}));
const client = vi.hoisted(() => ({ accountId: 'acc-1', isConnected: true }));
vi.mock('../../api/jmap-client', () => ({ jmapClient: client }));

import {
  getCalendarEventNotifications,
  destroyCalendarEventNotifications,
} from '../../api/calendar-event-notifications';
import { useCalendarEventNotificationStore as useStore } from '../calendar-event-notification-store';

const mockList = getCalendarEventNotifications as ReturnType<typeof vi.fn>;
const mockDestroy = destroyCalendarEventNotifications as ReturnType<typeof vi.fn>;

const n = (id: string) => ({ id, type: 'created', created: '', changedBy: { name: 'A', email: 'a@x' }, comment: null, calendarEventId: 'e' + id, isDraft: false });
const ids = () => useStore.getState().pending.map((p) => p.id);

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  client.accountId = 'acc-1';
  useStore.getState().reset();
  // reset() keeps the seen set (a notice must not toast twice); use fresh ids per test.
});

describe('calendar event notification store', () => {
  it('queues fetched notices tagged with their account, and dedupes on a second fetch', async () => {
    mockList.mockResolvedValue([n('d1'), n('d2')]);
    await useStore.getState().fetch();
    expect(ids()).toEqual(['d1', 'd2']);
    expect(useStore.getState().pending[0].accountId).toBe('acc-1');
    mockList.mockResolvedValue([n('d1'), n('d2'), n('d3')]);
    await useStore.getState().fetch();
    expect(ids()).toEqual(['d1', 'd2', 'd3']);
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

  it('acknowledge removes locally first, then destroys on the notices account', async () => {
    mockList.mockResolvedValue([n('a1'), n('a2')]);
    await useStore.getState().fetch();
    const d = deferred<void>();
    mockDestroy.mockReturnValue(d.promise);
    const p = useStore.getState().acknowledge(['a1']);
    expect(ids()).toEqual(['a2']);
    expect(mockDestroy).toHaveBeenCalledWith(['a1'], 'acc-1');
    d.resolve();
    await p;
  });

  it('a destroy failure does not bring the notice back, even on the next fetch', async () => {
    mockList.mockResolvedValue([n('f1')]);
    await useStore.getState().fetch();
    mockDestroy.mockRejectedValue(new Error('boom'));
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await useStore.getState().acknowledge(['f1']);
    expect(ids()).toEqual([]);
    await useStore.getState().fetch(); // server still lists f1
    expect(ids()).toEqual([]);
    warn.mockRestore();
  });

  it('drops a fetch that lands after reset (account switch / sign-out)', async () => {
    const d = deferred<unknown[]>();
    mockList.mockReturnValue(d.promise);
    const p = useStore.getState().fetch();
    useStore.getState().reset();
    client.accountId = 'acc-2';
    d.resolve([n('r1')]);
    await p;
    expect(ids()).toEqual([]);
    // and it was not marked seen: the real account's fetch still shows it
    mockList.mockResolvedValue([n('r1')]);
    await useStore.getState().fetch();
    expect(ids()).toEqual(['r1']);
    expect(useStore.getState().pending[0].accountId).toBe('acc-2');
  });

  it('a new fetch after reset is not coalesced into the stale one', async () => {
    const d = deferred<unknown[]>();
    mockList.mockReturnValueOnce(d.promise);
    const stale = useStore.getState().fetch();
    useStore.getState().reset();
    mockList.mockResolvedValueOnce([n('s1')]);
    await useStore.getState().fetch();
    expect(ids()).toEqual(['s1']);
    d.resolve([n('s2')]);
    await stale;
    expect(ids()).toEqual(['s1']);
  });

  it('does not toast a notice again after reset when the same account serves it', async () => {
    mockList.mockResolvedValue([n('k1')]);
    await useStore.getState().fetch();
    await useStore.getState().acknowledge(['k1']);
    useStore.getState().reset();
    await useStore.getState().fetch();
    expect(ids()).toEqual([]);
  });
});
