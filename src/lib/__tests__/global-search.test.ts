import { describe, it, expect, vi } from 'vitest';
import { accountMatches, hasRemoteQuery, matchesTerms, parseSearchQuery } from '../global-search/query-parser';
import { mergeHits, rankHits } from '../global-search/rank';
import { localOutcome, runGlobalSearch } from '../global-search/run';
import { calendarFilterFor, mailFilterFor, pathOfNode } from '../global-search/filters';
import { scopedQuery } from '../global-search/use-global-search';
import type { GlobalSearchHit, SearchAccount, SearchOutcome, SearchProvider } from '../global-search/types';
import type { FileNode } from '../../api/types';

// Ported from the webmail's lib/global-search/__tests__ (query-parser,
// rank, run-global-search), on the app's types.

const ACCOUNTS: SearchAccount[] = [
  { localAccountId: 'a', label: 'Work', email: 'me@work.example', active: true },
  { localAccountId: 'b', label: 'Home', email: 'me@home.example', active: false },
];

function hit(partial: Partial<GlobalSearchHit> & { id: string }): GlobalSearchHit {
  return {
    kind: 'mail', localAccountId: 'a', jmapAccountId: 'j', shared: false, accountLabel: 'Work',
    title: partial.id, subtitle: '', date: null, source: 'local',
    email: { id: partial.id, threadId: 't', subject: partial.id } as never, snippet: null,
    ...partial,
  } as GlobalSearchHit;
}

describe('parseSearchQuery', () => {
  it('keeps words and quoted phrases as text, lower-cased terms for local matching', () => {
    const parsed = parseSearchQuery('Annual "Q3 Report"');
    expect(parsed.text).toBe('Annual "Q3 Report"');
    expect(parsed.terms).toEqual(['annual', 'q3 report']);
    expect(parsed.scope).toBe('all');
  });

  it('reads scope, account and the mail operators', () => {
    const parsed = parseSearchQuery('in:events account:Work from:anna subject:plan has:attachment is:unread after:2026-01-01 before:2026-02-01 budget');
    expect(parsed.scope).toBe('calendar');
    expect(parsed.account).toBe('work');
    expect(parsed.mail).toMatchObject({ from: 'anna', subject: 'plan', hasAttachment: true, isUnread: true, dateAfter: '2026-01-01', dateBefore: '2026-02-01' });
    expect(parsed.after).toBe('2026-01-01');
    expect(parsed.text).toBe('budget');
  });

  it('makes in:trash a mail search of that folder, and is:anything keeps Trash and Junk in', () => {
    expect(parseSearchQuery('in:trash x')).toMatchObject({ scope: 'mail', mailboxRole: 'trash' });
    expect(parseSearchQuery('is:anything x').includeTrashAndJunk).toBe(true);
  });

  it('keeps malformed dates and unknown operators as free text', () => {
    const parsed = parseSearchQuery('after:2026-02-30 foo:bar ticket');
    expect(parsed.after).toBeNull();
    expect(parsed.text).toBe('after:2026-02-30 foo:bar ticket');
  });

  it('lets an explicit in: win over the scope chip', () => {
    expect(scopedQuery('x', 'files').scope).toBe('files');
    expect(scopedQuery('in:contacts x', 'files').scope).toBe('contacts');
  });

  it('asks the server for mail on operators alone, for the other kinds only with text', () => {
    const parsed = parseSearchQuery('is:unread');
    expect(hasRemoteQuery(parsed, 'mail')).toBe(true);
    expect(hasRemoteQuery(parsed, 'contacts')).toBe(false);
  });
});

describe('matching helpers', () => {
  it('needs every term in some field', () => {
    expect(matchesTerms(['ann', 'plan'], ['Anna Smith', 'Project plan'])).toBe(true);
    expect(matchesTerms(['ann', 'zzz'], ['Anna Smith'])).toBe(false);
    expect(matchesTerms([], ['x'])).toBe(false);
  });

  it('matches a login by label, address prefix or id', () => {
    expect(accountMatches('wor', { ...ACCOUNTS[0] })).toBe(true);
    expect(accountMatches('me@home', { ...ACCOUNTS[1] })).toBe(true);
    expect(accountMatches('home', { ...ACCOUNTS[0] })).toBe(false);
  });
});

describe('server filters', () => {
  const mailboxes = [
    { id: 'in', role: 'inbox', name: 'Inbox' },
    { id: 'tr', role: 'trash', name: 'Trash' },
    { id: 'sp', role: 'junk', name: 'Junk' },
  ];

  it('searches every folder but Trash and Junk by default', () => {
    expect(mailFilterFor(parseSearchQuery('invoice'), mailboxes)).toEqual({
      operator: 'AND', conditions: [{ text: 'invoice' }, { inMailboxOtherThan: ['tr', 'sp'] }],
    });
  });

  it('searches Trash alone with in:trash, and everything with is:anything', () => {
    expect(mailFilterFor(parseSearchQuery('in:trash invoice'), mailboxes)).toEqual({
      operator: 'AND', conditions: [{ text: 'invoice' }, { inMailbox: 'tr' }],
    });
    expect(mailFilterFor(parseSearchQuery('is:anything invoice'), mailboxes)).toEqual({ text: 'invoice' });
  });

  it('turns the mail operators into conditions', () => {
    const filter = mailFilterFor(parseSearchQuery('from:anna is:starred has:attachment'), []);
    expect(filter).toEqual({
      operator: 'AND',
      conditions: [{ from: 'anna' }, { hasAttachment: true }, { hasKeyword: '$flagged' }],
    });
  });

  it('bounds the calendar search by whole days, one AND group for several parts', () => {
    expect(calendarFilterFor(parseSearchQuery('standup after:2026-03-01'))).toEqual({ text: 'standup', after: '2026-03-01T00:00:00Z' });
    expect(calendarFilterFor(parseSearchQuery('"team sync" weekly before:2026-03-31'))).toEqual({
      operator: 'AND',
      conditions: [{ before: '2026-03-31T23:59:59Z' }, { text: '"team sync"' }, { text: 'weekly' }],
    });
  });

  it('finds the folder path of a file', () => {
    const nodes = [
      { id: '1', name: 'Docs', parentId: null },
      { id: '2', name: 'Tax', parentId: '1' },
      { id: '3', name: 'return.pdf', parentId: '2' },
    ] as FileNode[];
    expect(pathOfNode(nodes, nodes[2])).toBe('/Docs/Tax');
    expect(pathOfNode(nodes, nodes[0])).toBe('/');
  });
});

describe('rank and merge', () => {
  it('puts exact and prefix title matches first, then newer hits', () => {
    const parsed = parseSearchQuery('plan');
    const ranked = rankHits([
      hit({ id: 'old', title: 'about the plan', date: '2026-01-01T00:00:00Z' }),
      hit({ id: 'new', title: 'about the plan', date: '2026-02-01T00:00:00Z' }),
      hit({ id: 'exact', title: 'Plan' }),
      hit({ id: 'prefix', title: 'Planning day' }),
    ], parsed);
    expect(ranked.map((h) => h.id)).toEqual(['exact', 'prefix', 'new', 'old']);
  });

  it('lets a server hit replace the loaded one, and keeps the same id of two accounts apart', () => {
    const merged = mergeHits(
      [hit({ id: '1', source: 'local' }), hit({ id: '1', jmapAccountId: 'other', source: 'local' })],
      [hit({ id: '1', source: 'remote', title: 'from server' })],
    );
    expect(merged).toHaveLength(2);
    expect(merged.find((h) => h.jmapAccountId === 'j')?.source).toBe('remote');
    // A loaded hit never replaces a server one.
    expect(mergeHits(merged, [hit({ id: '1', source: 'local' })]).find((h) => h.jmapAccountId === 'j')?.source).toBe('remote');
  });
});

describe('runGlobalSearch', () => {
  const provider = (over: Partial<SearchProvider>): SearchProvider => ({
    kind: 'mail',
    local: () => [],
    remote: async () => ({ hits: [], hasMore: false }),
    ...over,
  });

  it('shows the loaded hits first, then merges each account answer, and reports a failed account', async () => {
    const updates: SearchOutcome[] = [];
    const mail = provider({
      local: () => [hit({ id: 'cached', title: 'plan cached' })],
      remote: async (_p, account) => {
        if (account.localAccountId === 'b') throw new Error('boom');
        return { hits: [hit({ id: 'server', title: 'plan server', source: 'remote' })], hasMore: true };
      },
    });
    const result = await runGlobalSearch({
      parsed: parseSearchQuery('plan'), accounts: ACCOUNTS, providers: [mail],
      localLimit: 10, remoteLimit: 10, signal: new AbortController().signal,
      onUpdate: (o) => updates.push(o),
    });
    expect(updates[0].hits.mail.map((h) => h.id)).toEqual(['cached']);
    expect(updates[0].status.mail.status).toBe('loading');
    expect(result.hits.mail.map((h) => h.id).sort()).toEqual(['cached', 'server']);
    expect(result.status.mail).toMatchObject({ status: 'done', hasMore: true });
    expect(result.status.mail.errors).toEqual([{ localAccountId: 'b', accountLabel: 'Home', message: 'boom' }]);
  });

  it('asks only the account named by account:, and only the kind of the scope', async () => {
    const asked: string[] = [];
    const mail = provider({ remote: async (_p, a) => { asked.push(`mail:${a.localAccountId}`); return { hits: [], hasMore: false }; } });
    const files = provider({ kind: 'files', remote: async (_p, a) => { asked.push(`files:${a.localAccountId}`); return { hits: [], hasMore: false }; } });
    await runGlobalSearch({
      parsed: parseSearchQuery('in:mail account:home plan'), accounts: ACCOUNTS, providers: [mail, files],
      localLimit: 10, remoteLimit: 10, signal: new AbortController().signal, onUpdate: () => undefined,
    });
    expect(asked).toEqual(['mail:b']);
  });

  it('gives up on a slow account after the time limit', async () => {
    vi.useFakeTimers();
    try {
      const slow = provider({ remote: () => new Promise(() => undefined) });
      const done = runGlobalSearch({
        parsed: parseSearchQuery('plan'), accounts: [ACCOUNTS[0]], providers: [slow],
        localLimit: 10, remoteLimit: 10, signal: new AbortController().signal, onUpdate: () => undefined, timeoutMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(1001);
      const result = await done;
      expect(result.status.mail.errors[0].message).toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes nothing after the search was replaced', async () => {
    const controller = new AbortController();
    const onUpdate = vi.fn();
    const mail = provider({ remote: async () => { controller.abort(); return { hits: [hit({ id: 'late' })], hasMore: false }; } });
    await runGlobalSearch({
      parsed: parseSearchQuery('plan'), accounts: [ACCOUNTS[0]], providers: [mail],
      localLimit: 10, remoteLimit: 10, signal: controller.signal, onUpdate,
    });
    const last = onUpdate.mock.calls.at(-1)?.[0] as SearchOutcome;
    expect(last.hits.mail.map((h) => h.id)).not.toContain('late');
  });

  it('runs no local pass for a query of operators only', () => {
    const local = vi.fn(() => [hit({ id: 'x' })]);
    const outcome = localOutcome(parseSearchQuery('is:unread'), ACCOUNTS, [provider({ local })], 10);
    expect(local).not.toHaveBeenCalled();
    expect(outcome.status.mail.status).toBe('loading');
  });
});
