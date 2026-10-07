import { describe, expect, it } from 'vitest';
import { emptyOutcome, type GlobalSearchHit, type SearchKind, type SearchOutcome } from '../types';
import { hitKey, MAX_ROWS_PER_KIND, searchAccountsFrom, searchRows, showNoResults } from '../view-model';

function hit(kind: SearchKind, id: string, appAccountId = 'login-a', jmapAccountId = 'ja'): GlobalSearchHit {
  return {
    kind, id, appAccountId, jmapAccountId, accountLabel: appAccountId, title: id, subtitle: '',
    date: null, source: 'remote',
  } as GlobalSearchHit;
}

function outcomeWith(patch: (o: SearchOutcome) => void): SearchOutcome {
  const o = emptyOutcome();
  for (const kind of ['mail', 'contacts', 'calendar', 'files'] as const) o.status[kind].status = 'done';
  patch(o);
  return o;
}

const many = (kind: SearchKind, n: number) => Array.from({ length: n }, (_, i) => hit(kind, `${kind}-${i}`));

describe('searchRows', () => {
  it('groups by kind in kind order, with counts, at most 5 rows and a Show all', () => {
    const outcome = outcomeWith((o) => {
      o.hits.files = many('files', 2);
      o.hits.mail = many('mail', 8);
    });
    const rows = searchRows(outcome, 'all', new Set());
    expect(rows.map((r) => r.type === 'hit' ? r.hit.id : `${r.type}:${'kind' in r ? r.kind : ''}`)).toEqual([
      'header:mail', 'mail-0', 'mail-1', 'mail-2', 'mail-3', 'mail-4', 'show_all:mail',
      'header:files', 'files-0', 'files-1',
    ]);
    expect(rows[0]).toEqual(expect.objectContaining({ type: 'header', kind: 'mail', count: 8, hasMore: false, loading: false }));
    expect(rows[6]).toEqual(expect.objectContaining({ type: 'show_all', kind: 'mail', hidden: 3 }));
    expect(MAX_ROWS_PER_KIND).toBe(5);
  });

  it('shows every row of an expanded group, then Load more for mail with more on the server', () => {
    const outcome = outcomeWith((o) => {
      o.hits.mail = many('mail', 8);
      o.status.mail.hasMore = true;
    });
    const collapsed = searchRows(outcome, 'all', new Set());
    expect(collapsed.some((r) => r.type === 'load_more')).toBe(false);
    const rows = searchRows(outcome, 'all', new Set(['mail']));
    expect(rows.filter((r) => r.type === 'hit')).toHaveLength(8);
    expect(rows[rows.length - 1]).toEqual({ type: 'load_more', key: 'load_more' });
    expect(rows[0]).toEqual(expect.objectContaining({ count: 8, hasMore: true }));
  });

  it('shows every row when the scope is one kind', () => {
    const outcome = outcomeWith((o) => {
      o.hits.mail = many('mail', 7);
      o.hits.files = many('files', 3);
    });
    const rows = searchRows(outcome, 'mail', new Set());
    expect(rows.filter((r) => r.type === 'hit')).toHaveLength(7);
    expect(rows.some((r) => r.type === 'show_all')).toBe(false);
    expect(rows.some((r) => r.type === 'header' && r.kind === 'files')).toBe(false);
  });

  it('keeps a loading group and per-account error rows, and drops an empty finished one', () => {
    const outcome = outcomeWith((o) => {
      o.status.contacts.status = 'loading';
      o.status.calendar.errors = [{ appAccountId: 'login-b', accountLabel: 'Bob', message: 'x' }];
    });
    const rows = searchRows(outcome, 'all', new Set());
    expect(rows).toEqual([
      expect.objectContaining({ type: 'header', kind: 'contacts', count: 0, loading: true }),
      expect.objectContaining({ type: 'header', kind: 'calendar', count: 0, loading: false }),
      expect.objectContaining({ type: 'error', kind: 'calendar', accountLabel: 'Bob' }),
    ]);
  });

  it("keeps two accounts' same-id hits apart in its row keys", () => {
    const outcome = outcomeWith((o) => {
      o.hits.mail = [hit('mail', '1', 'login-a', 'ja'), hit('mail', '1', 'login-b', 'jb')];
    });
    const keys = searchRows(outcome, 'all', new Set()).map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(hitKey(outcome.hits.mail[0])).not.toBe(hitKey(outcome.hits.mail[1]));
  });
});

describe('showNoResults', () => {
  it('only once nothing is searching, the query has something and no kind found anything', () => {
    const empty = outcomeWith(() => {});
    expect(showNoResults(empty, 'all', { isSearching: false, isEmpty: false })).toBe(true);
    expect(showNoResults(empty, 'all', { isSearching: true, isEmpty: false })).toBe(false);
    expect(showNoResults(empty, 'all', { isSearching: false, isEmpty: true })).toBe(false);
    const found = outcomeWith((o) => { o.hits.files = many('files', 1); });
    expect(showNoResults(found, 'all', { isSearching: false, isEmpty: false })).toBe(false);
    // A hit outside the scope doesn't count.
    expect(showNoResults(found, 'mail', { isSearching: false, isEmpty: false })).toBe(true);
    // An account that couldn't be searched isn't "no results".
    const failed = outcomeWith((o) => {
      o.status.mail.errors = [{ appAccountId: 'login-b', accountLabel: 'Bob', message: 'x' }];
    });
    expect(showNoResults(failed, 'all', { isSearching: false, isEmpty: false })).toBe(false);
    // ...unless it is outside the scope.
    expect(showNoResults(failed, 'files', { isSearching: false, isEmpty: false })).toBe(true);
  });
});

describe('searchAccountsFrom', () => {
  it("gives each account its own id, label and server", () => {
    const accounts = searchAccountsFrom([
      { id: 'login-a', email: 'a@x.test', username: 'a', serverUrl: 'https://one.test' },
      { id: 'login-b', email: '', username: 'bob', serverUrl: 'https://two.test' },
    ]);
    expect(accounts).toEqual([
      { appAccountId: 'login-a', label: 'a@x.test', email: 'a@x.test', serverUrl: 'https://one.test' },
      { appAccountId: 'login-b', label: 'bob', email: '', serverUrl: 'https://two.test' },
    ]);
  });
});
