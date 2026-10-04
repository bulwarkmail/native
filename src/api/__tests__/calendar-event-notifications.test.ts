import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    getMaxObjectsInSet: vi.fn(() => 2),
  },
}));
vi.mock('../../lib/capabilities', () => ({ hasCalendarCapability: vi.fn() }));

import { jmapClient } from '../jmap-client';
import { hasCalendarCapability } from '../../lib/capabilities';
import {
  getCalendarEventNotifications,
  destroyCalendarEventNotifications,
} from '../calendar-event-notifications';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;
const mockCap = hasCalendarCapability as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockCap.mockReturnValue(true);
});

describe('getCalendarEventNotifications', () => {
  it('queries created ascending with a back-referenced get', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [
        ['CalendarEventNotification/query', { ids: ['n1'] }, '0'],
        ['CalendarEventNotification/get', { list: [{ id: 'n1', type: 'created' }] }, '1'],
      ],
    });
    const list = await getCalendarEventNotifications();
    expect(list).toEqual([{ id: 'n1', type: 'created' }]);
    const [calls, using] = mockRequest.mock.calls[0];
    expect(using).toContain('urn:ietf:params:jmap:calendars');
    expect(calls[0]).toEqual(['CalendarEventNotification/query', {
      accountId: 'acc-1',
      sort: [{ property: 'created', isAscending: true }],
    }, '0']);
    expect(calls[1][0]).toBe('CalendarEventNotification/get');
    expect(calls[1][1]['#ids']).toEqual({ resultOf: '0', name: 'CalendarEventNotification/query', path: '/ids' });
    expect(calls[1][1].properties).toEqual(
      ['id', 'created', 'changedBy', 'comment', 'type', 'calendarEventId', 'isDraft', 'event']);
  });

  it('returns [] without the calendar capability, sending nothing', async () => {
    mockCap.mockReturnValue(false);
    expect(await getCalendarEventNotifications()).toEqual([]);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('throws when the server answers with an error', async () => {
    mockRequest.mockResolvedValue({ methodResponses: [['error', { description: 'nope' }, '0']] });
    await expect(getCalendarEventNotifications()).rejects.toThrow('nope');
  });
});

describe('destroyCalendarEventNotifications', () => {
  it('destroys in maxObjectsInSet batches', async () => {
    mockRequest.mockResolvedValue({ methodResponses: [['CalendarEventNotification/set', {}, '0']] });
    await destroyCalendarEventNotifications(['a', 'b', 'c'], 'acc-1');
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(mockRequest.mock.calls[0][0][0]).toEqual(
      ['CalendarEventNotification/set', { accountId: 'acc-1', destroy: ['a', 'b'] }, '0']);
    expect(mockRequest.mock.calls[1][0][0][1].destroy).toEqual(['c']);
  });

  it('never destroys on an account other than the one the notices came from', async () => {
    await destroyCalendarEventNotifications(['a'], 'acc-other');
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('re-checks the account before every batch and warns when it skips', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockRequest.mockImplementation(async () => {
      (jmapClient as { accountId: string }).accountId = 'acc-other';
      return { methodResponses: [] };
    });
    await destroyCalendarEventNotifications(['a', 'b', 'c'], 'acc-1');
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).not.toMatch(/acc-|['"]a['"]/);
    (jmapClient as { accountId: string }).accountId = 'acc-1';
    warn.mockRestore();
  });

  it('does nothing for no ids or without the capability', async () => {
    await destroyCalendarEventNotifications([], 'acc-1');
    mockCap.mockReturnValue(false);
    await destroyCalendarEventNotifications(['a'], 'acc-1');
    expect(mockRequest).not.toHaveBeenCalled();
  });
});
