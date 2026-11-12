import { describe, expect, it, vi } from 'vitest';

// #1567: past maxObjectsInGet, Stalwart refuses the get, so nothing was ever
// shown or acknowledged again. The notifications are read a page at a time.
const h = vi.hoisted(() => {
  const all = Array.from({ length: 5 }, (_, i) => ({
    id: `n${i}`, created: '2026-11-01T00:00:00Z', type: 'updated', calendarEventId: `e${i}`, event: { title: `T${i}` },
  }));
  const request = vi.fn(async (calls: [string, Record<string, unknown>, string][]) => {
    const query = calls[0][1] as { position?: number; limit?: number };
    const get = calls[1][1];
    if (!get['#ids']) throw new Error('expected a result reference');
    const position = query.position ?? 0;
    const limit = query.limit ?? all.length;
    // A get of more ids than maxObjectsInGet (2) is refused, as Stalwart does.
    if (limit > 2) return { methodResponses: [['error', { type: 'requestTooLarge', description: 'too many ids' }, '1']] };
    const page = all.slice(position, position + limit);
    return {
      methodResponses: [
        ['CalendarEventNotification/query', { ids: page.map((n) => n.id), position }, '0'],
        ['CalendarEventNotification/get', { list: page }, '1'],
      ],
    };
  });
  return { all, request };
});

vi.mock('../jmap-client', () => ({
  jmapClient: { accountId: 'u', request: h.request, getMaxObjectsInGet: () => 2, getMaxObjectsInSet: () => 2 },
}));

import { getCalendarEventNotifications } from '../calendar-event-notifications';

describe('reading calendar event notifications', () => {
  it('reads them a page of maxObjectsInGet at a time until a short page', async () => {
    const list = await getCalendarEventNotifications();
    expect(list.map((n) => n.id)).toEqual(['n0', 'n1', 'n2', 'n3', 'n4']);
    expect(h.request.mock.calls.map(([calls]) => (calls[0][1] as { position: number }).position)).toEqual([0, 2, 4]);
  });
});
