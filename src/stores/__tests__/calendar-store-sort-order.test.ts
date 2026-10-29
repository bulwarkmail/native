import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/calendar', () => ({
  getCalendars: vi.fn(),
  updateCalendar: vi.fn(),
  createCalendar: vi.fn(),
  isCalendarAccessDenied: vi.fn(() => false),
  noteCalendarAccessError: vi.fn(() => false),
  resetCalendarAccessDenied: vi.fn(),
  supportsSyntheticCalendarIds: vi.fn(async () => false),
  resetSyntheticIdSupport: vi.fn(),
}));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: { accountId: 'acc-1', isConnected: true },
}));

vi.mock('../../device-sync/app/request', () => ({ requestDeviceSync: vi.fn() }));

import * as calendarApi from '../../api/calendar';
import { useCalendarStore } from '../calendar-store';
import type { Calendar } from '../../api/types';

const mockGetCalendars = calendarApi.getCalendars as ReturnType<typeof vi.fn>;
const mockUpdateCalendar = calendarApi.updateCalendar as ReturnType<typeof vi.fn>;

const cal = (overrides: Partial<Calendar>): Calendar => ({ id: 'c', name: 'Cal', sortOrder: 0, ...overrides });
const names = () => useCalendarStore.getState().calendars.map((c) => c.name);

beforeEach(() => {
  vi.clearAllMocks();
  useCalendarStore.setState({ calendars: [], error: null });
});

describe('calendar order', () => {
  it('fetchCalendars lists the calendars by sortOrder, not in server order', async () => {
    mockGetCalendars.mockResolvedValue([
      cal({ id: 'b', name: 'Default', sortOrder: 20 }),
      cal({ id: 'n', name: 'Holidays', sortOrder: 30 }),
      cal({ id: 'e', name: 'Work', sortOrder: 1 }),
    ]);

    await useCalendarStore.getState().fetchCalendars();

    expect(names()).toEqual(['Work', 'Default', 'Holidays']);
  });

  it('reorderCalendars writes only the sortOrders that change, to the owning account', async () => {
    useCalendarStore.setState({
      calendars: [
        cal({ id: 'a', name: 'A', sortOrder: 1 }),
        cal({ id: 'b', name: 'B', sortOrder: 2 }),
        cal({ id: 'x:c', originalId: 'c', name: 'C', sortOrder: 0, isShared: true, accountId: 'x' }),
      ],
    });
    mockUpdateCalendar.mockResolvedValue(undefined);

    const done = useCalendarStore.getState().reorderCalendars(['b', 'a']);
    expect(names()).toEqual(['B', 'A', 'C']);
    await done;

    expect(mockUpdateCalendar.mock.calls).toEqual([
      ['b', { sortOrder: 1 }, 'acc-1'],
      ['a', { sortOrder: 2 }, 'acc-1'],
    ]);
  });

  it('after a failed write, shows the order the server holds and rethrows', async () => {
    useCalendarStore.setState({
      calendars: [
        cal({ id: 'a', name: 'A', sortOrder: 1 }),
        cal({ id: 'b', name: 'B', sortOrder: 2 }),
        cal({ id: 'c', name: 'C', sortOrder: 3 }),
      ],
    });
    mockUpdateCalendar.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('forbidden'));

    await expect(useCalendarStore.getState().reorderCalendars(['c', 'a', 'b'])).rejects.toThrow('forbidden');

    expect(useCalendarStore.getState().calendars.map((c) => [c.id, c.sortOrder])).toEqual([
      ['a', 1], ['c', 1], ['b', 2],
    ]);
  });
});
