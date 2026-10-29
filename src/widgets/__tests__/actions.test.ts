import { beforeEach, describe, expect, it, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { MailItem, WidgetSnapshot } from '../snapshot';

// A fake server and a fake refresh: the refresh reads the server when it
// starts and stores what it read when `release` lets it finish, which is how
// a slow refresh overlaps a second tap on the device.
const server = vi.hoisted(() => ({ inbox: [] as string[] }));
const calls = vi.hoisted(() => ({ moves: [] as Array<{ id: string; resolve: (ok: boolean) => void }> }));

vi.mock('../jmap', () => ({
  openClient: vi.fn(async () => ({})),
  markRead: vi.fn(async () => true),
  rsvp: vi.fn(async () => true),
  setTaskDone: vi.fn(async () => true),
  moveTo: vi.fn((_client: unknown, id: string) => new Promise<boolean>((resolve) => {
    calls.moves.push({
      id,
      resolve: (ok) => {
        if (ok) server.inbox = server.inbox.filter((x) => x !== id);
        resolve(ok);
      },
    });
  })),
}));

vi.mock('../render', () => ({ redrawAll: vi.fn(async () => undefined) }));

vi.mock('../build', async () => {
  const { storeRefresh } = await import('../state');
  return {
    singletonServes: () => false,
    refreshSnapshot: vi.fn(async () => {
      const startedAt = Date.now();
      const read = [...server.inbox];
      await new Promise((r) => setTimeout(r, 5));
      await storeRefresh(snapshotOf(read), startedAt);
    }),
  };
});

function mail(id: string): MailItem {
  return {
    id, threadId: `t${id}`, accountId: 'acc', fromName: id, fromEmail: `${id}@x`, initials: 'X', color: '#123456',
    subject: id, preview: '', receivedAt: 0, unread: true, starred: false, hasAttachment: false, threadSize: 1,
  };
}

function snapshotOf(ids: string[]): WidgetSnapshot {
  return {
    version: 1, generatedAt: Date.now(), appDataAt: 0, signedIn: true, theme: 'light', locale: 'en', hour12: false,
    weekStart: 1, accounts: [], activeAccountId: 'acc',
    mail: {
      folders: [{ role: 'inbox', name: 'Inbox', unread: ids.length, total: ids.length }],
      inbox: ids.map(mail), unified: [], starred: [], starredCount: 0, drafts: [], draftCount: 0, scheduled: [],
      pendingChanges: 0, favourites: [], recentSearches: [], tags: [], attachments: [],
    },
    calendar: { supported: true, events: [], invitations: [], birthdays: [] },
    tasks: { supported: true, items: [] },
    files: { supported: false, items: [] },
    vacation: null,
    quota: null,
  };
}

const jmap = await import('../jmap');
const { handleWidgetAction } = await import('../actions');
const { currentView } = await import('../state');
const { saveSnapshot } = await import('../snapshot');

const shown = async () => (await currentView()).mail.inbox.map((m) => m.id);
const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(check()).toBe(true);
};

beforeEach(async () => {
  await AsyncStorage.clear();
  calls.moves = [];
  server.inbox = ['m1', 'm2', 'm3'];
  await saveSnapshot(snapshotOf(server.inbox));
});

describe('widget task ticks and RSVPs', () => {
  it('go to the account the tapped drawing showed, not the one the widgets show now', async () => {
    // The widgets moved on to acc2, which has a task with the same JMAP id.
    const s = snapshotOf([]);
    s.activeAccountId = 'acc2';
    s.tasks.items = [{
      id: 'e', serverId: 'e', accountId: 'acc2', title: 'Theirs', dueHasTime: false, done: false, calendarName: '', color: '#123456',
    }];
    await saveSnapshot(s);
    vi.mocked(jmap.openClient).mockClear();
    vi.mocked(jmap.setTaskDone).mockClear();
    await handleWidgetAction('toggleTask', { id: 'e', done: true, serverId: 'e', accountId: 'acc', title: 'Mine' }, 1);
    expect(jmap.openClient).toHaveBeenCalledWith('acc');
    expect(jmap.setTaskDone).toHaveBeenCalledWith(expect.anything(), 'e', true, undefined);
  });

  it('mark a task done on both of two quick taps rather than undoing the first', async () => {
    vi.mocked(jmap.setTaskDone).mockClear();
    const tap = { id: 't', done: true, serverId: 't', accountId: 'acc', title: 'Task' };
    await Promise.all([handleWidgetAction('toggleTask', tap, 1), handleWidgetAction('toggleTask', tap, 1)]);
    expect(vi.mocked(jmap.setTaskDone).mock.calls.map((c) => c[2])).toEqual([true, true]);
  });

  it('send an RSVP with the ids the tap carries', async () => {
    vi.mocked(jmap.rsvp).mockClear();
    await handleWidgetAction('rsvp', {
      id: 'h1', status: 'accepted', serverId: 'j', participantId: 'a', accountId: 'acc', jmapAccountId: 'd', title: 'Budget',
    }, 1);
    expect(jmap.rsvp).toHaveBeenCalledWith(expect.anything(), 'j', 'a', 'accepted', 'd');
  });
});

describe('widget archive', () => {
  it('keeps a message archived when a refresh read the server before its archive landed', async () => {
    const first = handleWidgetAction('archive', { id: 'm1', accountId: 'acc' }, 7);
    const second = handleWidgetAction('archive', { id: 'm2', accountId: 'acc' }, 7);
    await until(() => calls.moves.length === 2);
    expect(await shown()).toEqual(['m3']);

    // The first archive lands; its refresh reads a server that still has m2.
    calls.moves[0].resolve(true);
    await first;
    expect(server.inbox).toEqual(['m2', 'm3']);
    expect(await shown()).toEqual(['m3']);

    calls.moves[1].resolve(true);
    await second;
    expect(await shown()).toEqual(['m3']);
  });

  it('brings a message back when its archive did not reach the server', async () => {
    const tap = handleWidgetAction('archive', { id: 'm1', accountId: 'acc' }, 7);
    await until(() => calls.moves.length === 1);
    expect(await shown()).toEqual(['m2', 'm3']);
    calls.moves[0].resolve(false);
    await tap;
    expect(await shown()).toEqual(['m1', 'm2', 'm3']);
  });

  it('says so on the widget, with the tap to repeat, and shows the message again', async () => {
    const tap = handleWidgetAction('archive', { id: 'm2', accountId: 'acc' }, 7);
    await until(() => calls.moves.length === 1);
    calls.moves[0].resolve(false);
    await tap;
    const view = await currentView();
    expect(view.notice).toMatchObject({ action: 'archive', label: 'm2', retry: { id: 'm2', accountId: 'acc' } });
    expect(JSON.parse((await AsyncStorage.getItem('widgets:local:7'))!)).toEqual({ triageId: 'm2' });

    // Tapping the notice repeats the archive and clears it.
    const retry = handleWidgetAction(view.notice!.action, view.notice!.retry, 7);
    await until(() => calls.moves.length === 2);
    expect((await currentView()).notice).toBeNull();
    calls.moves[1].resolve(true);
    await retry;
    expect(await shown()).toEqual(['m1', 'm3']);
    expect((await currentView()).notice).toBeNull();
  });

  it('does not lose either of two taps that land together', async () => {
    const taps = [
      handleWidgetAction('archive', { id: 'm1', accountId: 'acc' }, 7),
      handleWidgetAction('trash', { id: 'm3', accountId: 'acc' }, 7),
    ];
    await until(() => calls.moves.length === 2);
    expect(await shown()).toEqual(['m2']);
    for (const move of calls.moves) move.resolve(true);
    await Promise.all(taps);
    expect(await shown()).toEqual(['m2']);
  });

  it('moves the triage card on to the next unread message', async () => {
    const tap = handleWidgetAction('archive', { id: 'm1', accountId: 'acc' }, 7);
    await until(() => calls.moves.length === 1);
    expect(JSON.parse((await AsyncStorage.getItem('widgets:local:7'))!)).toEqual({ triageId: 'm2' });
    calls.moves[0].resolve(true);
    await tap;
  });
});
