import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeJmap, type FakeEmail } from './fake-jmap-server';

// #1082: "All folders" used to send one Email/query to the account of the
// open folder, so the 5 "zephyr" messages in the team (group) inbox never
// showed up next to the 3 in the user's own account. It now asks every
// account whose folders are in the sidebar, in one request, and stamps each
// row with its account so opening and acting on it reach the right one.

const server = vi.hoisted(() => ({ current: null as null | ReturnType<typeof import('./fake-jmap-server').createFakeJmap> }));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    isConnected: true,
    accountId: 'c',
    username: 'me@example.com',
    serverUrl: 'https://mail.example.com',
    // No hasKeyword sort option: the list sort stays plain receivedAt and no
    // polarity probe goes out.
    currentSession: {
      apiUrl: 'https://mail.example.com/jmap/',
      accounts: {
        c: { accountCapabilities: { 'urn:ietf:params:jmap:mail': { emailQuerySortOptions: ['receivedAt'] } } },
        team: { accountCapabilities: { 'urn:ietf:params:jmap:mail': { emailQuerySortOptions: ['receivedAt'] } } },
      },
    },
    getMaxObjectsInGet: () => 500,
    getMaxObjectsInSet: () => 500,
    getMaxCallsInRequest: () => 16,
    getSharedMailAccounts: () => [{ id: 'team', name: 'Team' }],
    request: vi.fn((calls) => server.current!.request(calls)),
  },
}));

vi.mock('../locale-store', () => ({
  t: (_key: string, fallback?: string) => fallback ?? _key,
  useLocaleStore: { getState: () => ({ locale: 'en', t: (_k: string, f?: string) => f ?? _k }) },
}));

// Online, nothing queued: run the store's online path, or each op's primitive.
vi.mock('../outbox-store', async () => {
  const api = await import('../../api/email');
  type Op = { kind: string; emailId: string; accountId?: string; patch?: never; mailboxIds?: never };
  const runOp = async (op: Op) => {
    if (op.kind === 'keywords') return api.patchKeywordsForEmails([op.emailId], op.patch!, op.accountId);
    if (op.kind === 'mailboxes') return api.setEmailMailboxes(op.emailId, op.mailboxIds!, op.accountId);
    if (op.kind === 'destroy') return api.destroyEmails([op.emailId], op.accountId);
  };
  const applyOrQueueBatch = async (ops: Op[], onlineRun?: () => Promise<void>) => {
    if (onlineRun) await onlineRun();
    else for (const op of ops) await runOp(op);
    return { queued: false };
  };
  return {
    applyOrQueueBatch,
    applyOrQueue: async (op: Op, onlineRun?: () => Promise<void>) => applyOrQueueBatch([op], onlineRun),
    useOutboxStore: { getState: () => ({ setAccount: vi.fn(async () => undefined), flush: vi.fn(async () => undefined) }) },
  };
});

vi.mock('../settings-store', () => {
  const settings: Record<string, unknown> = {};
  return {
    useSettingsStore: {
      getState: () => ({
        ...settings,
        updateSetting: (key: string, value: unknown) => { settings[key] = value; },
      }),
    },
    __settings: settings,
  };
});

vi.mock('../offline-cache-store', () => ({
  useOfflineCacheStore: {
    getState: () => ({
      hydrated: true,
      hydrate: vi.fn(),
      setAccount: vi.fn(async () => undefined),
      totalCount: () => 0,
      getEmailsInMailbox: vi.fn(async () => []),
      has: () => false,
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
      patch: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    }),
  },
}));

import { generateAccountId } from '../../lib/account-utils';
import * as settingsModule from '../settings-store';
import {
  useEmailStore, viewerParamsForRow, deleteDestroysAcrossAccounts, accountIdOfRow,
} from '../email-store';
import type { Email, Mailbox } from '../../api/types';

const settings = (settingsModule as unknown as { __settings: Record<string, unknown> }).__settings;

function mb(id: string, role: string | null, shared?: { raw: string }): Mailbox {
  return {
    id,
    name: role ?? id,
    role,
    totalEmails: 0, unreadEmails: 0, totalThreads: 0, unreadThreads: 0,
    myRights: {} as Mailbox['myRights'],
    ...(shared
      ? { originalId: shared.raw, accountId: 'team', accountName: 'Team', isShared: true }
      : { accountId: 'c', isShared: false }),
  };
}

const MAILBOXES: Mailbox[] = [
  mb('inbox', 'inbox'), mb('archive', 'archive'), mb('trash', 'trash'), mb('junk', 'junk'),
  mb('team:t-inbox', 'inbox', { raw: 't-inbox' }),
  mb('team:t-archive', 'archive', { raw: 't-archive' }),
  mb('team:t-trash', 'trash', { raw: 't-trash' }),
  mb('team:t-junk', 'junk', { raw: 't-junk' }),
];

function mail(id: string, folder: string, day: number, subject: string, extra: Partial<FakeEmail> = {}): Email {
  return {
    id,
    size: 1,
    hasAttachment: false,
    threadId: `t-${id}`,
    mailboxIds: { [folder]: true },
    keywords: {},
    receivedAt: `2026-09-${String(day).padStart(2, '0')}T10:00:00Z`,
    subject,
    ...extra,
  };
}

function seed() {
  return createFakeJmap({
    c: [
      mail('o1', 'inbox', 20, 'zephyr launch'),
      mail('o2', 'archive', 14, 'zephyr notes'),
      mail('o3', 'inbox', 9, 'zephyr retro'),
      mail('o4', 'inbox', 21, 'lunch'),
    ],
    team: [
      mail('m1', 't-inbox', 22, 'zephyr ticket 1'),
      mail('m2', 't-inbox', 18, 'zephyr ticket 2'),
      mail('m3', 't-inbox', 15, 'zephyr ticket 3'),
      mail('m4', 't-inbox', 12, 'zephyr ticket 4'),
      mail('m5', 't-trash', 8, 'zephyr ticket 5'),
    ],
  });
}

const ids = () => useEmailStore.getState().emails.map((e) => e.id);

async function search(query: string) {
  useEmailStore.getState().setSearchQuery(query);
  await vi.waitFor(() => expect(useEmailStore.getState().loading).toBe(false));
}

beforeEach(() => {
  server.current = seed();
  for (const key of Object.keys(settings)) delete settings[key];
  Object.assign(settings, {
    emailsPerPage: 25,
    mailSortAscending: false,
    disableThreading: false,
    deleteAction: 'trash',
    permanentlyDeleteJunk: false,
    archiveMode: 'single',
    messageListOrder: [],
    messageListOrderScope: 'inbox',
  });
  useEmailStore.getState().reset();
  useEmailStore.setState({
    activeAccountId: generateAccountId('me@example.com', 'https://mail.example.com'),
    mailboxes: MAILBOXES,
    currentMailboxId: 'inbox',
    pendingUndo: null,
  });
});

describe('"All folders" search across the own and the team account (#1082)', () => {
  it('finds the team inbox matches too, in one request', async () => {
    await search('zephyr');

    expect(ids()).toEqual(['m1', 'o1', 'm2', 'm3', 'o2', 'm4', 'o3', 'm5']);
    expect(useEmailStore.getState().totalEmails).toBe(8);
    expect(server.current!.requests).toHaveLength(1);
    const queries = server.current!.callsOf('Email/query');
    expect(queries.map(([, args]) => args.accountId)).toEqual(['c', 'team']);
    for (const [, args] of queries) expect(args.filter).toEqual({ text: 'zephyr*' });
    expect(server.current!.callsOf('Email/get').map(([, args]) => args.accountId)).toEqual(['c', 'team']);
  });

  it('stamps every row with its account and scopes its conversation size', async () => {
    await search('zephyr');

    const rows = useEmailStore.getState().emails;
    expect(rows.find((e) => e.id === 'o1')?.jmapAccountId).toBe('c');
    expect(rows.find((e) => e.id === 'm1')?.jmapAccountId).toBe('team');
    expect(useEmailStore.getState().threadCounts).toMatchObject({ 'c:t-o1': 1, 'team:t-m1': 1 });
    expect(accountIdOfRow(rows.find((e) => e.id === 'm1')!)).toBe('team');
    expect(accountIdOfRow(rows.find((e) => e.id === 'o1')!)).toBeUndefined();
  });

  it('keeps a search scoped to one folder in that folder\'s account', async () => {
    useEmailStore.setState({ filters: { folder: 'team:t-inbox' } });
    await search('zephyr');

    const queries = server.current!.callsOf('Email/query');
    expect(queries).toHaveLength(1);
    expect(queries[0][1]).toMatchObject({ accountId: 'team', filter: { inMailbox: 't-inbox', text: 'zephyr*' } });
    expect(ids()).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(useEmailStore.getState().emails[0].jmapAccountId).toBeUndefined();
  });

  it('asks only the own account when no shared folders are in the sidebar', async () => {
    useEmailStore.setState({ mailboxes: MAILBOXES.filter((m) => !m.isShared) });
    await search('zephyr');

    expect(server.current!.callsOf('Email/query').map(([, args]) => args.accountId)).toEqual(['c']);
    expect(ids()).toEqual(['o1', 'o2', 'o3']);
  });

  it('continues each account from its own rows on load more, skipping none', async () => {
    settings.emailsPerPage = 2;
    await search('zephyr');
    expect(ids()).toEqual(['m1', 'o1', 'm2', 'o2']);

    await useEmailStore.getState().loadMoreEmails();
    const page2 = server.current!.requests[1].filter(([n]) => n === 'Email/query');
    expect(page2.map(([, a]) => [a.accountId, a.position])).toEqual([['c', 2], ['team', 2]]);
    expect(ids()).toEqual(['m1', 'o1', 'm2', 'm3', 'o2', 'm4', 'o3']);

    await useEmailStore.getState().loadMoreEmails();
    const page3 = server.current!.requests[2].filter(([n]) => n === 'Email/query');
    expect(page3.map(([, a]) => [a.accountId, a.position])).toEqual([['c', 3], ['team', 4]]);
    expect(ids()).toEqual(['m1', 'o1', 'm2', 'm3', 'o2', 'm4', 'o3', 'm5']);

    // Everything is loaded: no further request.
    await useEmailStore.getState().loadMoreEmails();
    expect(server.current!.requests).toHaveLength(3);
  });

  it('shows the reachable account\'s hits when the other one fails', async () => {
    server.current!.failing.set('team', 'forbidden');
    await search('zephyr');

    expect(ids()).toEqual(['o1', 'o2', 'o3']);
    expect(useEmailStore.getState().accountErrors).toEqual({ team: 'forbidden' });
    expect(useEmailStore.getState().error).toBeNull();
  });

  it('reports an error when no account answers', async () => {
    server.current!.failing.set('team', 'forbidden');
    server.current!.failing.set('c', 'serverFail');
    await search('zephyr');

    expect(ids()).toEqual([]);
    expect(useEmailStore.getState().error).toBe('serverFail');
  });

  it('keeps two accounts\' rows with the same ids apart', async () => {
    server.current = createFakeJmap({
      c: [mail('x', 'inbox', 20, 'zephyr own')],
      team: [mail('x', 't-inbox', 21, 'zephyr team')],
    });
    await search('zephyr');

    const rows = useEmailStore.getState().emails;
    expect(rows.map((e) => [e.id, e.jmapAccountId])).toEqual([['x', 'team'], ['x', 'c']]);
  });

  it('re-runs the search when only the team account reports a change', async () => {
    await search('zephyr');
    server.current!.accounts.team.push(mail('m6', 't-inbox', 23, 'zephyr ticket 6'));

    await useEmailStore.getState().handleStateChange({
      '@type': 'StateChange', changed: { team: { Email: 's2' } },
    } as never);

    expect(ids()[0]).toBe('m6');
  });
});

describe('opening and acting on "All folders" rows (#1082)', () => {
  it('opens a team row in the team account, paging over the team rows', async () => {
    await search('zephyr');
    const row = useEmailStore.getState().emails.find((e) => e.id === 'm2')!;

    expect(viewerParamsForRow(row)).toEqual({ jmapAccountId: 'team', emailIds: ['m1', 'm2', 'm3', 'm4', 'm5'] });
  });

  it('opens an own row in the own account while a team folder is open', async () => {
    useEmailStore.setState({ currentMailboxId: 'team:t-inbox' });
    await search('zephyr');
    const own = useEmailStore.getState().emails.find((e) => e.id === 'o1')!;

    // The key is present, so it overrides the open folder's account.
    const params = viewerParamsForRow(own);
    expect('jmapAccountId' in params).toBe(true);
    expect(params).toEqual({ jmapAccountId: undefined, emailIds: ['o1', 'o2', 'o3'] });
  });

  it("acts on the viewer's message in the account it names, not a same-id row", async () => {
    server.current = createFakeJmap({
      c: [mail('x', 'inbox', 20, 'zephyr own')],
      team: [mail('x', 't-inbox', 21, 'zephyr team')],
    });
    await search('zephyr');
    const team = useEmailStore.getState().emails.find((e) => e.jmapAccountId === 'team')!;

    await useEmailStore.getState().setKeywordForEmails(['x'], '$flagged', true, { email: team, accountId: 'team' });

    expect(server.current!.callsOf('Email/set').map(([, a]) => a.accountId)).toEqual(['team']);
    expect(server.current!.accounts.c[0].keywords).toEqual({});
  });

  it("marks the viewer's message read in the account it names", async () => {
    server.current = createFakeJmap({
      c: [mail('x', 'inbox', 20, 'zephyr own')],
      team: [mail('x', 't-inbox', 21, 'zephyr team')],
    });
    await search('zephyr');

    // The own message, although the team row with the same id comes first.
    await useEmailStore.getState().markRead('x', undefined);
    await useEmailStore.getState().markRead('x', 'team');

    expect(server.current!.callsOf('Email/set').map(([, a]) => a.accountId)).toEqual(['c', 'team']);
  });

  it('marks a mixed selection read with one Email/set per account', async () => {
    await search('zephyr');
    await useEmailStore.getState().setKeywordForEmails(['o1', 'm1'], '$seen', true);

    const sets = server.current!.callsOf('Email/set');
    expect(sets.map(([, a]) => [a.accountId, Object.keys(a.update as object)])).toEqual([['team', ['m1']], ['c', ['o1']]]);
    expect(server.current!.accounts.team.find((e) => e.id === 'm1')!.keywords).toEqual({ $seen: true });
  });

  it('stars a team row in the team account', async () => {
    await search('zephyr');
    await useEmailStore.getState().toggleStar('m3', true);

    expect(server.current!.callsOf('Email/set')[0][1]).toEqual({
      accountId: 'team', update: { m3: { 'keywords/$flagged': true } },
    });
  });

  it('archives each row into its own account\'s Archive, and undo puts them back', async () => {
    await search('zephyr');
    await useEmailStore.getState().archiveEmailsBatch(['o1', 'm1']);

    const sets = server.current!.callsOf('Email/set');
    expect(sets.map(([, a]) => [a.accountId, a.update])).toEqual([
      ['team', { m1: { mailboxIds: { 't-archive': true } } }],
      ['c', { o1: { mailboxIds: { archive: true } } }],
    ]);
    expect(ids()).not.toContain('o1');
    expect(ids()).not.toContain('m1');

    await useEmailStore.getState().undoLast();
    expect(server.current!.accounts.c.find((e) => e.id === 'o1')!.mailboxIds).toEqual({ inbox: true });
    expect(server.current!.accounts.team.find((e) => e.id === 'm1')!.mailboxIds).toEqual({ 't-inbox': true });
    expect(ids()).toContain('o1');
    expect(ids()).toContain('m1');
  });

  it('moves a hit to Trash out of the folder it is in, not the open one', async () => {
    await search('zephyr');
    // o2 sits in Archive while the Inbox is open.
    await useEmailStore.getState().deleteEmail('o2', 'trash', 'inbox');

    expect(server.current!.accounts.c.find((e) => e.id === 'o2')!.mailboxIds).toEqual({ trash: true });
  });

  it('confirms before deleting a hit that already sits in its account\'s Trash', async () => {
    await search('zephyr');
    expect(deleteDestroysAcrossAccounts(['m1'])).toBe(false);
    expect(deleteDestroysAcrossAccounts(['m1', 'm5'])).toBe(true);

    await useEmailStore.getState().deleteEmailsBatch(['m1', 'm5'], 'trash', 'inbox');
    expect(server.current!.callsOf('Email/set').map(([, a]) => [a.accountId, a.update ?? a.destroy])).toEqual([
      ['team', ['m5']],
      ['team', { m1: { mailboxIds: { 't-trash': true } } }],
    ]);
    expect(server.current!.accounts.team.map((e) => e.id)).not.toContain('m5');
  });

  it('files spam in each row\'s own Junk', async () => {
    await search('zephyr');
    await useEmailStore.getState().markSpam(['m2']);

    expect(server.current!.callsOf('Email/set')[0][1]).toEqual({
      accountId: 'team',
      update: { m2: { mailboxIds: { 't-junk': true }, 'keywords/$junk': true, 'keywords/$notjunk': null } },
    });
  });

  it('leaves the rows of a single folder on the folder\'s account', async () => {
    const own = mail('o4', 'inbox', 21, 'lunch');
    useEmailStore.setState({ emails: [own], totalEmails: 1 });
    expect(viewerParamsForRow(own)).toEqual({});
    expect(deleteDestroysAcrossAccounts(['o4'])).toBeNull();
  });
});
