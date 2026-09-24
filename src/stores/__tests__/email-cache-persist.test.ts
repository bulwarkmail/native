import { describe, it, expect } from 'vitest';
import type { Email } from '../../api/types';
import {
  boundEmailCache,
  PERSISTED_ROWS_PER_FOLDER,
  PERSISTED_ROWS_TOTAL,
  type PersistedEmailCache,
} from '../email-cache-persist';
import { useEmailStore, type AccountSnapshot, type EmailState } from '../email-store';

function row(id: string, extra: Partial<Email> = {}): Email {
  return {
    id,
    threadId: `t-${id}`,
    mailboxIds: { inbox: true },
    keywords: { $seen: true },
    size: 4096,
    receivedAt: '2026-09-01T10:00:00Z',
    from: [{ name: 'Jane Doe', email: 'jane.doe@example.com' }],
    to: [{ name: 'Max Mustermann', email: 'max@example.org' }],
    subject: `Quarterly report ${id}`,
    preview: 'Hi Max, attached is the quarterly report. Let me know if the numbers look right to you. '.repeat(3),
    hasAttachment: false,
    ...extra,
  };
}

function rows(prefix: string, n: number): Email[] {
  return Array.from({ length: n }, (_, i) => row(`${prefix}${i}`));
}

function account(snaps: Record<string, Email[]>, currentMailboxId: string | null = null): AccountSnapshot {
  return {
    mailboxes: [],
    emailStates: {},
    currentMailboxId,
    mailboxSnapshots: Object.fromEntries(
      Object.entries(snaps).map(([id, emails]) => [id, { emails, total: 1000, queryState: `q-${id}` }]),
    ),
  };
}

function cache(active: AccountSnapshot, others: Record<string, AccountSnapshot> = {}): PersistedEmailCache {
  return { ...active, accountSnapshots: others, activeAccountId: 'me' };
}

const rowCount = (a: AccountSnapshot) =>
  Object.values(a.mailboxSnapshots).reduce((n, s) => n + s.emails.length, 0);

describe('boundEmailCache', () => {
  it('keeps at most a page-sized prefix per folder, with its queryState and total', () => {
    const inbox = rows('i', 250);
    const out = boundEmailCache(cache(account({ inbox }, 'inbox')));
    const snap = out.mailboxSnapshots.inbox;
    expect(snap.emails).toHaveLength(PERSISTED_ROWS_PER_FOLDER);
    expect(snap.emails.map((e) => e.id)).toEqual(inbox.slice(0, PERSISTED_ROWS_PER_FOLDER).map((e) => e.id));
    expect(snap.total).toBe(1000);
    expect(snap.queryState).toBe('q-inbox');
  });

  it('fills the current folder first and drops folders past the overall budget', () => {
    const folders: Record<string, Email[]> = {};
    for (let i = 0; i < 8; i++) folders[`f${i}`] = rows(`f${i}-`, 100);
    folders.empty = [];
    const active = account({ ...folders, current: rows('c', 100) }, 'current');
    const other = account({ inbox: rows('o', 100) }, 'inbox');

    const out = boundEmailCache(cache(active, { them: other }));

    expect(out.mailboxSnapshots.current.emails).toHaveLength(100);
    expect(out.mailboxSnapshots.empty).toEqual({ emails: [], total: 1000, queryState: 'q-empty' });
    expect(rowCount(out) + rowCount(out.accountSnapshots.them)).toBe(PERSISTED_ROWS_TOTAL);
    expect(Object.keys(out.mailboxSnapshots)).toHaveLength(6);
    expect(out.accountSnapshots.them.mailboxSnapshots).toEqual({});
  });

  it('leaves out the stale copy of the active account', () => {
    const out = boundEmailCache(
      cache(account({ inbox: rows('i', 3) }, 'inbox'), { me: account({ inbox: rows('old', 3) }), them: account({}) }),
    );
    expect(Object.keys(out.accountSnapshots)).toEqual(['them']);
  });

  it('drops message bodies from rows seeded out of the offline cache', () => {
    const full = row('full', {
      bodyValues: { 1: { value: 'x'.repeat(100_000) } },
      htmlBody: [{ partId: '1', type: 'text/html' } as never],
      textBody: [],
      attachments: [],
      headers: [{ name: 'Subject', value: 'hi' }],
      bodyStructure: { partId: '1', type: 'text/html' } as never,
    });
    const [persisted] = boundEmailCache(cache(account({ inbox: [full] }, 'inbox'))).mailboxSnapshots.inbox.emails;
    expect(Object.keys(persisted).sort()).toEqual(Object.keys(row('x')).sort());
  });

  it('keeps a full cache well under the ~2 MB Android can read back', () => {
    const folders: Record<string, Email[]> = {};
    for (let i = 0; i < 10; i++) folders[`f${i}`] = rows(`f${i}-`, 300);
    const json = JSON.stringify(boundEmailCache(cache(account(folders, 'f0'))));
    expect(json.length).toBeLessThan(1_000_000);
  });
});

describe('email-store persistence', () => {
  const { partialize, merge } = useEmailStore.persist.getOptions();

  function viewState(overrides: Partial<EmailState>): EmailState {
    return {
      ...useEmailStore.getInitialState(),
      activeAccountId: 'me',
      currentMailboxId: 'inbox',
      ...overrides,
    };
  }

  it('stores the open folder once, from the live list', () => {
    const live = rows('live', 3);
    const persisted = partialize!(viewState({
      emails: live,
      totalEmails: 42,
      queryState: 'q2',
      mailboxSnapshots: { inbox: { emails: rows('old', 3), total: 40, queryState: 'q1' } },
    })) as PersistedEmailCache;

    expect(persisted).not.toHaveProperty('emails');
    expect(persisted.mailboxSnapshots.inbox).toEqual({ emails: live, total: 42, queryState: 'q2' });
    expect(JSON.stringify(persisted).match(/"id":"live0"/g)).toHaveLength(1);
  });

  it('hands the storage the same slice when only UI flags change', () => {
    const state = viewState({ emails: rows('live', 3), mailboxSnapshots: {} });
    const slice = partialize!(state);
    expect(partialize!({ ...state, loading: true, error: 'offline' })).toBe(slice);
    expect(partialize!({ ...state, emails: rows('live', 4) })).not.toBe(slice);
  });

  it('keeps the base view, not search results, for the open folder', () => {
    const base = { emails: rows('base', 2), total: 2, queryState: 'q1' };
    const persisted = partialize!(viewState({
      searchQuery: 'invoice',
      emails: rows('hit', 1),
      mailboxSnapshots: { inbox: base },
    })) as PersistedEmailCache;

    expect(persisted.mailboxSnapshots.inbox).toEqual(base);
  });

  it('restores the open folder into the list on hydration', () => {
    const live = rows('live', 3);
    const persisted = JSON.parse(JSON.stringify(partialize!(viewState({
      emails: live,
      totalEmails: 42,
      queryState: 'q2',
      mailboxSnapshots: {},
    }))));

    const restored = merge!(persisted, useEmailStore.getInitialState());

    expect(restored.currentMailboxId).toBe('inbox');
    expect(restored.emails.map((e) => e.id)).toEqual(live.map((e) => e.id));
    expect(restored.totalEmails).toBe(42);
    expect(restored.queryState).toBe('q2');
    expect(restored.mailboxSnapshots.inbox.emails).toHaveLength(3);
    expect(restored.loading).toBe(false);
  });

  it('restores a row written before the list was stored once', () => {
    const snap = { emails: rows('base', 2), total: 2, queryState: 'q1' };
    const legacy = {
      accountSnapshots: {},
      activeAccountId: 'me',
      mailboxes: [],
      emailStates: {},
      currentMailboxId: 'inbox',
      mailboxSnapshots: { inbox: snap },
      emails: rows('hit', 1),
      totalEmails: 1,
      queryState: undefined,
    };

    const restored = merge!(legacy, useEmailStore.getInitialState());

    expect(restored.emails).toEqual(snap.emails);
    expect(restored.totalEmails).toBe(2);
    expect(restored.queryState).toBe('q1');
  });

  it('keeps the initial state when nothing was stored', () => {
    const initial = useEmailStore.getInitialState();
    expect(merge!(undefined, initial)).toBe(initial);
  });
});
