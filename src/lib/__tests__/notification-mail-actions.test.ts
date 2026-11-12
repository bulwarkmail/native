import { describe, it, expect } from 'vitest';
import { archiveFromNotification, notificationCode, planNotificationArchive } from '../notification-mail-actions';

// Archive and Copy code on a new-mail notification (webmail public/sw.js and
// app/api/push/action, desktop 677903094).

describe('planNotificationArchive', () => {
  const archive = { id: 'arch', name: 'Archive', role: 'archive', parentId: null };

  it('files into the Archive folder, by role or by name', () => {
    expect(planNotificationArchive([archive], 'single', undefined)).toEqual({ destination: 'arch', create: {} });
    expect(planNotificationArchive([{ id: 'a2', name: 'archive', role: null }], 'single', undefined).destination).toBe('a2');
  });

  it('makes the Archive folder where the account has none', () => {
    expect(planNotificationArchive([{ id: 'inbox', name: 'Inbox', role: 'inbox' }], 'single', undefined)).toEqual({
      destination: '#archive',
      create: { archive: { name: 'Archive', parentId: null, role: 'archive' } },
    });
  });

  it('files by year and month, making the folders that are missing', () => {
    const receivedAt = new Date(2026, 10, 3, 12).toISOString();
    const year = { id: 'y26', name: '2026', parentId: 'arch' };
    expect(planNotificationArchive([archive, year], 'month', receivedAt)).toEqual({
      destination: '#month',
      create: { month: { name: '11', parentId: 'y26' } },
    });
    expect(planNotificationArchive([archive], 'year', receivedAt)).toEqual({
      destination: '#year',
      create: { year: { name: '2026', parentId: 'arch' } },
    });
    expect(planNotificationArchive([], 'month', receivedAt).create).toEqual({
      archive: { name: 'Archive', parentId: null, role: 'archive' },
      year: { name: '2026', parentId: '#archive' },
      month: { name: '11', parentId: '#year' },
    });
  });
});

type Call = [string, Record<string, any>, string];

function fakeServer(opts: {
  mailboxes: Array<Record<string, unknown>>;
  mailboxIds?: Record<string, boolean>;
  refuseCreateOnce?: boolean;
  refuseWrite?: boolean;
}) {
  const requests: Call[][] = [];
  let refusedCreate = false;
  const post = async (calls: Call[]): Promise<Call[]> => {
    requests.push(calls);
    return calls.map(([method, args, id]): Call => {
      if (method === 'Mailbox/get') return [method, { list: opts.mailboxes }, id];
      if (method === 'Email/get') return [method, { list: [{ id: 'm1', mailboxIds: opts.mailboxIds ?? { inbox: true }, receivedAt: '2026-11-03T10:00:00Z' }] }, id];
      if (method === 'Mailbox/set' && args.create) {
        if (opts.refuseCreateOnce && !refusedCreate) {
          refusedCreate = true;
          // Another client made it meanwhile.
          opts.mailboxes.push({ id: 'theirs', name: 'Archive', role: 'archive' });
          return [method, { notCreated: { archive: { type: 'alreadyExists' } } }, id];
        }
        return [method, { created: Object.fromEntries(Object.keys(args.create).map((cid) => [cid, { id: `new-${cid}` }])) }, id];
      }
      if (method === 'Mailbox/set') return [method, { destroyed: args.destroy }, id];
      if (method === 'Email/set') {
        const target = Object.keys(Object.values(args.update as Record<string, { mailboxIds: object }>)[0].mailboxIds)[0];
        return opts.refuseWrite || target.startsWith('#') && opts.refuseCreateOnce && refusedCreate && requests.length === 2
          ? [method, { notUpdated: { m1: { type: 'invalidProperties' } } }, id]
          : [method, { updated: { m1: null } }, id];
      }
      return ['error', { type: 'unknownMethod' }, id];
    });
  };
  return { post, requests };
}

describe('archiveFromNotification', () => {
  it('moves the message to the Archive folder', async () => {
    const server = fakeServer({ mailboxes: [{ id: 'inbox', name: 'Inbox', role: 'inbox' }, { id: 'arch', name: 'Archive', role: 'archive' }] });
    expect(await archiveFromNotification(server.post, 'acc', 'm1', 'single')).toBe('archived');
    expect(server.requests[1]).toEqual([
      ['Email/set', { accountId: 'acc', update: { m1: { mailboxIds: { arch: true } } } }, 'write'],
    ]);
  });

  it('leaves a message in Trash or Junk where it is', async () => {
    const server = fakeServer({
      mailboxes: [{ id: 'trash', name: 'Trash', role: 'trash' }, { id: 'arch', name: 'Archive', role: 'archive' }],
      mailboxIds: { trash: true },
    });
    expect(await archiveFromNotification(server.post, 'acc', 'm1', 'single')).toBe('refused');
    expect(server.requests).toHaveLength(1);
  });

  it('does not file into a read-only Archive folder', async () => {
    const server = fakeServer({ mailboxes: [{ id: 'arch', name: 'Archive', role: 'archive', myRights: { mayAddItems: false } }] });
    expect(await archiveFromNotification(server.post, 'acc', 'm1', 'single')).toBe('refused');
    expect(server.requests).toHaveLength(1);
  });

  it('files into the folder another client made between the read and the write', async () => {
    const server = fakeServer({ mailboxes: [{ id: 'inbox', name: 'Inbox', role: 'inbox' }], refuseCreateOnce: true });
    expect(await archiveFromNotification(server.post, 'acc', 'm1', 'single')).toBe('archived');
    expect(server.requests.at(-1)).toEqual([
      ['Email/set', { accountId: 'acc', update: { m1: { mailboxIds: { theirs: true } } } }, 'write'],
    ]);
  });

  it('removes the folders it made when the server refuses the move', async () => {
    const server = fakeServer({ mailboxes: [{ id: 'inbox', name: 'Inbox', role: 'inbox' }], refuseWrite: true });
    expect(await archiveFromNotification(server.post, 'acc', 'm1', 'month')).toBe('refused');
    expect(server.requests.at(-1)).toEqual([
      ['Mailbox/set', { accountId: 'acc', destroy: ['new-month', 'new-year', 'new-archive'] }, 'cleanup'],
    ]);
  });
});

describe('notificationCode', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  it('finds the code of fresh mail when codes are shown', () => {
    const email = { subject: 'Your code is 482913', preview: '', receivedAt: '2026-11-12T11:59:00Z' };
    expect(notificationCode(email, true, now)).toBe('482913');
    expect(notificationCode(email, false, now)).toBeNull();
    expect(notificationCode({ ...email, receivedAt: '2026-11-10T11:59:00Z' }, true, now)).toBeNull();
  });
});
