import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  client: { isConnected: true, accountId: 'u', currentSession: { apiUrl: 'https://mail.example/jmap/' } as unknown },
  list: vi.fn(),
  destroy: vi.fn(async (_ids: string[]) => undefined),
  refresh: vi.fn(async () => undefined),
  toast: { info: vi.fn(), warning: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() },
}));

vi.mock('react-native', () => ({ AppState: { addEventListener: vi.fn() } }));
vi.mock('../../api/jmap-client', () => ({ jmapClient: h.client }));
vi.mock('../../api/calendar-event-notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/calendar-event-notifications')>()),
  getCalendarEventNotifications: h.list,
  destroyCalendarEventNotifications: h.destroy,
}));
vi.mock('../../stores/auth-store', () => ({ useAuthStore: { subscribe: vi.fn() } }));
vi.mock('../../stores/calendar-store', () => ({ useCalendarStore: { getState: () => ({ refresh: h.refresh }) } }));
vi.mock('../../stores/toast-store', () => ({ toast: h.toast }));
vi.mock('../../stores/locale-store', () => ({
  t: (_key: string, fallback?: string, params?: Record<string, string>) =>
    (fallback ?? '').replace(/\{(\w+)\}/g, (_, k: string) => params?.[k] ?? ''),
}));
vi.mock('../capabilities', () => ({ hasCalendarCapability: () => true }));

import fs from 'node:fs';
import path from 'node:path';
import {
  eventNotificationToast,
  pullCalendarEventNotifications,
  resetCalendarEventNotifications,
  startCalendarEventNotificationSync,
} from '../calendar-event-notifications';
import { dispatchStateChange } from '../state-change-bus';
import type { CalendarEventNotification } from '../../api/calendar-event-notifications';

// Ported from the webmail's components/layout/__tests__/calendar-event-notification-toaster.test.tsx
// and lib/__tests__/pending-notification-store.test.ts.

const t = (_key: string, fallback?: string, params?: Record<string, string | number>) =>
  (fallback ?? '').replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''));

function note(id: string, extra: Partial<CalendarEventNotification> = {}): CalendarEventNotification {
  return {
    id,
    created: '2026-10-31T05:00:00Z',
    changedBy: { name: 'Land', email: 'land@example.org', principalId: 't' },
    comment: null,
    type: 'updated',
    calendarEventId: 'e1',
    isDraft: false,
    event: { title: 'Planning' },
    ...extra,
  };
}

beforeEach(() => {
  resetCalendarEventNotifications();
  h.client.accountId = 'u';
  h.list.mockReset();
  h.destroy.mockClear();
  h.refresh.mockClear();
  for (const fn of Object.values(h.toast)) fn.mockClear();
});

describe('the toast for a calendar event notification', () => {
  it('says who invited, changed or cancelled which event', () => {
    expect(eventNotificationToast(note('1', { type: 'created' }), t)).toEqual({ type: 'info', title: 'Land invited you to "Planning"', message: undefined });
    expect(eventNotificationToast(note('2'), t)).toEqual({ type: 'info', title: 'Land updated "Planning"', message: undefined });
    expect(eventNotificationToast(note('3', { type: 'destroyed', comment: 'Sorry, ill' }), t))
      .toEqual({ type: 'warning', title: 'Land cancelled "Planning"', message: 'Sorry, ill' });
  });

  it('says cancelled, as a warning, when the organizer cancels (an update setting status cancelled)', () => {
    // What Stalwart 1.0.1 sends the attendee after CalendarEvent/set destroy
    // with sendSchedulingMessages; 0.16.27 sends the whole event as the patch.
    expect(eventNotificationToast(note('4', { eventPatch: { sequence: null, status: 'cancelled' } as never }), t))
      .toEqual({ type: 'warning', title: 'Land cancelled "Planning"', message: undefined });
    expect(eventNotificationToast(note('5', { event: null, eventPatch: { title: 'Planning', status: 'cancelled' } }), t)!.type)
      .toBe('warning');
    // Any other change stays an update.
    expect(eventNotificationToast(note('6', { eventPatch: { title: 'Planning v2' } }), t)!.type).toBe('info');
  });

  it('falls back to the address, then "Someone", and to an untitled event', () => {
    expect(eventNotificationToast(note('1', { changedBy: { email: 'x@example.org' }, event: null }), t)!.title)
      .toBe('x@example.org updated "Untitled event"');
    expect(eventNotificationToast(note('1', { changedBy: null }), t)!.title).toBe('Someone updated "Planning"');
  });

  it('shows nothing for a draft, the user’s own unsent change', () => {
    expect(eventNotificationToast(note('1', { isDraft: true }), t)).toBeNull();
  });
});

describe('pulling calendar event notifications', () => {
  it('shows each new one, refreshes the calendar and acknowledges them on the server', async () => {
    h.list.mockResolvedValue([note('a', { type: 'created' }), note('b', { type: 'destroyed' }), note('c', { isDraft: true })]);
    await pullCalendarEventNotifications();
    expect(h.toast.info).toHaveBeenCalledWith('Land invited you to "Planning"', undefined);
    expect(h.toast.warning).toHaveBeenCalledWith('Land cancelled "Planning"', undefined);
    expect(h.toast.info).toHaveBeenCalledTimes(1);
    expect(h.refresh).toHaveBeenCalledTimes(1);
    // Drafts are acknowledged too, as the webmail does.
    expect(h.destroy).toHaveBeenCalledWith(['a', 'b', 'c']);
  });

  it('does not show one again when the server still lists it', async () => {
    h.list.mockResolvedValue([note('a')]);
    await pullCalendarEventNotifications();
    await pullCalendarEventNotifications();
    expect(h.toast.info).toHaveBeenCalledTimes(1);
    expect(h.destroy).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there is nothing new', async () => {
    h.list.mockResolvedValue([]);
    await pullCalendarEventNotifications();
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.destroy).not.toHaveBeenCalled();
  });

  it('shows nothing from the previous account after a switch during the fetch', async () => {
    h.list.mockImplementation(async () => {
      h.client.accountId = 'other';
      return [note('a')];
    });
    await pullCalendarEventNotifications();
    expect(h.toast.info).not.toHaveBeenCalled();
    expect(h.destroy).not.toHaveBeenCalled();
  });

  it('pulls again when a push arrives during a pull', async () => {
    let release!: () => void;
    h.list.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve([note('a')]); }));
    h.list.mockResolvedValueOnce([note('a'), note('b')]);
    const first = pullCalendarEventNotifications();
    const second = pullCalendarEventNotifications();
    release();
    await Promise.all([first, second]);
    expect(h.list).toHaveBeenCalledTimes(2);
    expect(h.toast.info).toHaveBeenCalledTimes(2);
  });

  it('keeps quiet when the server refuses the listing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.list.mockRejectedValue(new Error('unknownMethod'));
    await expect(pullCalendarEventNotifications()).resolves.toBeUndefined();
    expect(h.toast.info).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('when notifications are pulled', () => {
  it('pulls on a CalendarEventNotification push', async () => {
    vi.useFakeTimers();
    try {
      h.list.mockResolvedValue([]);
      startCalendarEventNotificationSync();
      await vi.advanceTimersByTimeAsync(1500);
      h.list.mockClear();
      h.list.mockResolvedValue([note('p', { type: 'created' })]);
      dispatchStateChange({ '@type': 'StateChange', changed: { u: { CalendarEventNotification: 's2' } } });
      await vi.advanceTimersByTimeAsync(1500);
      expect(h.list).toHaveBeenCalledTimes(1);
      expect(h.toast.info).toHaveBeenCalledWith('Land invited you to "Planning"', undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts with the reminder sync, which the app starts at launch', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../calendar-notifications.ts'), 'utf8');
    const start = source.slice(source.indexOf('export function startCalendarNotificationSync'));
    expect(start).toMatch(/syncStarted = true;[\s\S]*startCalendarEventNotificationSync\(\);/);
  });
});
