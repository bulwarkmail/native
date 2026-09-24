import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyOwnWritesToList,
  beginOwnWrite,
  ownEmailWritesBetween,
  recordOwnEmailWrites,
  resetOwnWrites,
  whenOwnWritesSettled,
  type OwnEmailWrite,
} from '../own-writes';
import type { Email, JMAPMethodCall } from '../types';

const SERVER = 'https://mail.example.com';

beforeEach(() => resetOwnWrites());

function row(id: string, keywords: Record<string, boolean> = {}): Email {
  return { id, keywords, mailboxIds: { inbox: true } } as unknown as Email;
}

function write(partial: Partial<OwnEmailWrite>): OwnEmailWrite {
  return {
    server: SERVER, accountId: 'a', oldState: 's0', newState: 's1',
    created: [], updated: [], destroyed: [], ...partial,
  };
}

describe('recording own writes', () => {
  it('logs an Email/set with what it created, updated and destroyed', () => {
    const calls: JMAPMethodCall[] = [['Email/set', {
      accountId: 'a',
      create: { draft: { mailboxIds: { sent: true } } },
      update: { e1: { 'keywords/$seen': true } },
      destroy: ['e9'],
    }, '0']];
    recordOwnEmailWrites(SERVER, calls, [['Email/set', {
      accountId: 'a', oldState: 's0', newState: 's1',
      created: { draft: { id: 'e5' } }, updated: { e1: null }, destroyed: ['e9'],
    }, '0']]);

    expect(ownEmailWritesBetween(SERVER, 'a', 's0', 's1')).toEqual([{
      server: SERVER, accountId: 'a', oldState: 's0', newState: 's1',
      created: [{ id: 'e5', mailboxIds: { sent: true } }],
      updated: [{ id: 'e1', patch: { 'keywords/$seen': true } }],
      destroyed: ['e9'],
    }]);
  });

  it('reads the filing patch of a submission\'s implicit Email/set', () => {
    const calls: JMAPMethodCall[] = [
      ['Email/set', { accountId: 'a', create: { draft: { mailboxIds: { drafts: true } } } }, '0'],
      ['EmailSubmission/set', {
        accountId: 'a',
        create: { 'sub-1': { emailId: '#draft' } },
        onSuccessUpdateEmail: { '#sub-1': { mailboxIds: { sent: true }, 'keywords/$draft': null } },
      }, '1'],
    ];
    recordOwnEmailWrites(SERVER, calls, [
      ['Email/set', { accountId: 'a', oldState: 's0', newState: 's1', created: { draft: { id: 'e5' } } }, '0'],
      ['EmailSubmission/set', { accountId: 'a', created: { 'sub-1': { id: 'x' } } }, '1'],
      ['Email/set', { accountId: 'a', oldState: 's1', newState: 's2', updated: { e5: null } }, '1'],
    ]);

    const chain = ownEmailWritesBetween(SERVER, 'a', 's0', 's2');
    expect(chain?.map((w) => w.newState)).toEqual(['s1', 's2']);
    expect(chain?.[1].updated).toEqual([
      { id: 'e5', patch: { mailboxIds: { sent: true }, 'keywords/$draft': null } },
    ]);
  });

  it('only chains states our own writes connect, per server', () => {
    recordOwnEmailWrites(SERVER, [['Email/set', { accountId: 'a', update: { e1: {} } }, '0']], [
      ['Email/set', { accountId: 'a', oldState: 's0', newState: 's1', updated: { e1: null } }, '0'],
    ]);
    expect(ownEmailWritesBetween(SERVER, 'a', 's1', 's1')).toEqual([]);
    expect(ownEmailWritesBetween(SERVER, 'a', 's0', 's1')).toHaveLength(1);
    // New mail (or another client) moved the state on past our write.
    expect(ownEmailWritesBetween(SERVER, 'a', 's0', 's2')).toBeNull();
    expect(ownEmailWritesBetween('https://other.example', 'a', 's0', 's1')).toBeNull();
    expect(ownEmailWritesBetween(SERVER, 'b', 's0', 's1')).toBeNull();
  });

  it('ignores responses without states and failed methods', () => {
    recordOwnEmailWrites(SERVER, [['Email/set', { accountId: 'a' }, '0']], [
      ['error', { type: 'stateMismatch' }, '0'],
    ]);
    recordOwnEmailWrites(SERVER, [['Email/set', { accountId: 'a' }, '1']], [
      ['Email/set', { accountId: 'a', newState: 's1' }, '1'],
    ]);
    expect(ownEmailWritesBetween(SERVER, 'a', 's0', 's1')).toBeNull();
  });
});

describe('waiting for writes in flight', () => {
  it('resolves once the last write settled', async () => {
    const done = beginOwnWrite([['Email/set', {}, '0']]);
    let settled = false;
    const wait = whenOwnWritesSettled(10_000).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    done();
    await wait;
    expect(settled).toBe(true);
  });

  it('does not wait for reads', async () => {
    beginOwnWrite([['Email/get', {}, '0']]);
    await whenOwnWritesSettled(10_000);
  });
});

describe('applying own writes to a folder list', () => {
  const view = (emails: Email[], extra: Partial<Parameters<typeof applyOwnWritesToList>[1]> = {}) => ({
    emails,
    syncedIds: new Set(emails.map((e) => e.id)),
    folderId: 'inbox',
    sortKeywords: new Set(['$pinned']),
    ...extra,
  });

  it('patches keywords on the rows (again, if the optimistic update did already)', () => {
    const out = applyOwnWritesToList(
      [write({ updated: [{ id: 'e1', patch: { 'keywords/$seen': true } }, { id: 'e2', patch: { 'keywords/$answered': true } }] })],
      view([row('e1', { $seen: true }), row('e2')]),
    );
    expect(out?.emails.map((e) => e.keywords)).toEqual([{ $seen: true }, { $answered: true }]);
    expect(out?.removed).toBe(0);
  });

  it('needs a re-query when a sort keyword changed', () => {
    expect(applyOwnWritesToList(
      [write({ updated: [{ id: 'e1', patch: { 'keywords/$pinned': true } }] })],
      view([row('e1')]),
    )).toBeNull();
  });

  it('counts rows moved out of the folder, also ones already removed on screen', () => {
    const out = applyOwnWritesToList(
      [write({ updated: [
        { id: 'e1', patch: { 'mailboxIds/inbox': null, 'mailboxIds/archive': true } },
        { id: 'e2', patch: { mailboxIds: { trash: true } } },
      ], destroyed: ['e3'] })],
      view([row('e2'), row('e3'), row('e4')], { syncedIds: new Set(['e1', 'e2', 'e3', 'e4']) }),
    );
    expect(out?.emails.map((e) => e.id)).toEqual(['e4']);
    expect(out?.removed).toBe(3);
  });

  it('leaves messages created or destroyed elsewhere alone', () => {
    const out = applyOwnWritesToList(
      [write({ created: [{ id: 'n1', mailboxIds: { drafts: true } }], destroyed: ['old-draft'] })],
      view([row('e1')]),
    );
    expect(out).toEqual({ emails: [row('e1')], removed: 0 });
  });

  it('needs a re-query when a message joins the folder', () => {
    expect(applyOwnWritesToList([write({ created: [{ id: 'n1', mailboxIds: { inbox: true } }] })], view([]))).toBeNull();
    expect(applyOwnWritesToList([write({ created: [{ id: 'n1' }] })], view([]))).toBeNull();
    expect(applyOwnWritesToList(
      [write({ updated: [{ id: 'e9', patch: { mailboxIds: { inbox: true } } }] })],
      view([row('e1')]),
    )).toBeNull();
    // An undo put a removed row back on screen by date: re-query for its place.
    expect(applyOwnWritesToList(
      [write({ updated: [{ id: 'e1', patch: { mailboxIds: { inbox: true } } }] })],
      view([row('e1')], { syncedIds: new Set() }),
    )).toBeNull();
  });

  it('needs a re-query for an unknown change to a row or a move out of a message it does not hold', () => {
    expect(applyOwnWritesToList([write({ updated: [{ id: 'e1' }] })], view([row('e1')]))).toBeNull();
    expect(applyOwnWritesToList(
      [write({ updated: [{ id: 'e1', patch: { receivedAt: 'x' } }] })],
      view([row('e1')]),
    )).toBeNull();
    expect(applyOwnWritesToList(
      [write({ updated: [{ id: 'e9', patch: { 'mailboxIds/inbox': null } }] })],
      view([row('e1')]),
    )).toBeNull();
  });
});
