import { describe, expect, it } from 'vitest';
import {
  applyPending,
  confirmedBy,
  DONE_TTL_MS,
  expire,
  IN_FLIGHT_TTL_MS,
  NOTICE_TTL_MS,
  type PendingOp,
} from '../pending';
import { PREVIEW_NOW, sampleSnapshot } from '../sample-snapshot';

const op = (change: PendingOp['change'], extra: Partial<PendingOp> = {}): PendingOp => ({
  key: `${change.kind}:${change.id}`,
  change,
  at: 1000,
  ...extra,
});

describe('applyPending', () => {
  it('takes an archived message out of every list and the inbox counts', () => {
    const s = sampleSnapshot(PREVIEW_NOW);
    const target = s.mail.inbox.find((m) => m.unread)!;
    const inbox = s.mail.folders.find((f) => f.role === 'inbox')!;
    const shown = applyPending(s, [op({ kind: 'removeMail', id: target.id })]);
    expect(shown.mail.inbox.some((m) => m.id === target.id)).toBe(false);
    expect(shown.mail.unified.some((m) => m.id === target.id)).toBe(false);
    const after = shown.mail.folders.find((f) => f.role === 'inbox')!;
    expect([after.total, after.unread]).toEqual([inbox.total - 1, inbox.unread - 1]);
    // The stored snapshot is left as the server described it.
    expect(s.mail.inbox.some((m) => m.id === target.id)).toBe(true);
    expect(s.mail.folders.find((f) => f.role === 'inbox')!.total).toBe(inbox.total);
  });

  it('marks a message read once', () => {
    const s = sampleSnapshot(PREVIEW_NOW);
    const target = s.mail.inbox.find((m) => m.unread)!;
    const before = s.mail.folders.find((f) => f.role === 'inbox')!.unread;
    const twice = [op({ kind: 'markRead', id: target.id }), op({ kind: 'markRead', id: target.id }, { key: 'b' })];
    const shown = applyPending(s, twice);
    expect(shown.mail.inbox.find((m) => m.id === target.id)!.unread).toBe(false);
    expect(shown.mail.folders.find((f) => f.role === 'inbox')!.unread).toBe(before - 1);
  });

  it('answers an invitation and ticks a task', () => {
    const s = sampleSnapshot(PREVIEW_NOW);
    const inv = s.calendar.invitations[0];
    const task = s.tasks.items.find((t) => !t.done)!;
    const shown = applyPending(s, [
      op({ kind: 'rsvp', id: inv.id, serverId: inv.serverId, status: 'accepted' }),
      op({ kind: 'task', id: task.id, done: true }),
    ]);
    expect(shown.calendar.invitations.some((i) => i.serverId === inv.serverId)).toBe(false);
    expect(shown.tasks.items.find((t) => t.id === task.id)!.done).toBe(true);
    expect(s.tasks.items.find((t) => t.id === task.id)!.done).toBe(false);
  });
});

describe('applyPending across accounts', () => {
  it('leaves an item of another account with the same id alone', () => {
    const s = sampleSnapshot(PREVIEW_NOW);
    const task = s.tasks.items.find((t) => !t.done)!;
    const shown = applyPending(s, [op({ kind: 'task', id: task.id, done: true, accountId: 'not-this-one' })]);
    expect(shown.tasks.items.find((t) => t.id === task.id)!.done).toBe(false);
    const own = applyPending(s, [op({ kind: 'task', id: task.id, done: true, accountId: s.activeAccountId! })]);
    expect(own.tasks.items.find((t) => t.id === task.id)!.done).toBe(true);
  });
});

describe('confirmedBy', () => {
  const mail = op({ kind: 'removeMail', id: 'm' }, { doneAt: 2000 });
  const task = op({ kind: 'task', id: 't', done: true }, { doneAt: 2000 });
  const inFlight = op({ kind: 'removeMail', id: 'n' });

  it('keeps a change a refresh started before it reached the server', () => {
    // The refresh read the server at 1500, before the archive landed at 2000:
    // its data still has the message, so the op must keep hiding it.
    expect(confirmedBy([mail, inFlight], 1500, true)).toEqual([mail, inFlight]);
  });

  it('drops a mail change once a later refresh has stored it', () => {
    expect(confirmedBy([mail, inFlight], 2500, false)).toEqual([inFlight]);
  });

  it('keeps a task change until a refresh that loaded tasks', () => {
    expect(confirmedBy([task], 2500, false)).toEqual([task]);
    expect(confirmedBy([task], 2500, true)).toEqual([]);
  });
});

describe('expire', () => {
  it('drops stuck and stale ops and an old notice', () => {
    const now = 10_000_000;
    const stuck = op({ kind: 'removeMail', id: 'a' }, { at: now - IN_FLIGHT_TTL_MS - 1 });
    const fresh = op({ kind: 'removeMail', id: 'b' }, { at: now - 1000 });
    const stale = op({ kind: 'task', id: 'c', done: true }, { at: 0, doneAt: now - DONE_TTL_MS - 1 });
    const recent = op({ kind: 'task', id: 'd', done: true }, { at: 0, doneAt: now - 1000 });
    const notice = (at: number) => ({ action: 'archive' as const, label: 'x', at, retry: {} });
    expect(expire({ ops: [stuck, fresh, stale, recent], notice: notice(now - NOTICE_TTL_MS - 1) }, now))
      .toEqual({ ops: [fresh, recent], notice: null });
    expect(expire({ ops: [], notice: notice(now - 1000) }, now).notice).toEqual(notice(now - 1000));
  });
});
