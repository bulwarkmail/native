import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGlobalSearchController } from '../controller';
import type { GlobalSearchHit, SearchAccount, SearchProvider, RemoteSearchResult } from '../types';

function account(id: string): SearchAccount {
  return { appAccountId: id, label: id.toUpperCase(), email: `${id}@example.org` };
}

function hit(kind: GlobalSearchHit['kind'], appAccountId: string, id: string, source: 'local' | 'remote' = 'remote'): GlobalSearchHit {
  return {
    kind, appAccountId, id, jmapAccountId: 'j', accountLabel: appAccountId, title: id, subtitle: '', date: null, source,
    contact: {} as never, storeId: id,
  } as GlobalSearchHit;
}

function provider(kind: GlobalSearchHit['kind'], impl: Partial<SearchProvider>): SearchProvider {
  return { kind, supports: () => true, local: () => [], remote: async () => ({ hits: [], hasMore: false }), ...impl };
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
};

describe('createGlobalSearchController', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows local hits at once and asks the server only after the debounce', async () => {
    const remote = vi.fn(async (): Promise<RemoteSearchResult> => ({ hits: [hit('contacts', 'a', 'c2')], hasMore: false }));
    const c = createGlobalSearchController({
      providers: [provider('contacts', { local: () => [hit('contacts', 'a', 'c1', 'local')], remote })],
      accounts: () => [account('a')], localLimit: 5, remoteLimit: 5,
    });
    c.update({ query: 'bob', scope: 'all', accountId: null });
    expect(c.getState().outcome.hits.contacts.map((h) => h.id)).toEqual(['c1']);
    expect(c.getState().outcome.status.contacts.status).toBe('loading');
    expect(c.getState().isSearching).toBe(true);
    expect(remote).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(299);
    expect(remote).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(remote).toHaveBeenCalledTimes(1);
    expect(c.getState().outcome.hits.contacts.map((h) => h.id).sort()).toEqual(['c1', 'c2']);
    expect(c.getState().isSearching).toBe(false);
  });

  it('a fast typist only triggers the server for the last query', async () => {
    const remote = vi.fn(async (): Promise<RemoteSearchResult> => ({ hits: [], hasMore: false }));
    const c = createGlobalSearchController({
      providers: [provider('mail', { remote })], accounts: () => [account('a')], localLimit: 5, remoteLimit: 5,
    });
    c.update({ query: 'a', scope: 'all', accountId: null });
    await vi.advanceTimersByTimeAsync(100);
    c.update({ query: 'ab', scope: 'all', accountId: null });
    await vi.advanceTimersByTimeAsync(400);
    expect(remote).toHaveBeenCalledTimes(1);
  });

  it('drops results of a superseded search', async () => {
    const first = deferred<RemoteSearchResult>();
    const remote = vi.fn((parsed: { raw: string }) =>
      parsed.raw === 'one' ? first.promise : Promise.resolve({ hits: [hit('mail', 'a', 'new')], hasMore: false }));
    const c = createGlobalSearchController({
      providers: [provider('mail', { remote: remote as SearchProvider['remote'] })],
      accounts: () => [account('a')], localLimit: 5, remoteLimit: 5,
    });
    c.update({ query: 'one', scope: 'all', accountId: null });
    await vi.advanceTimersByTimeAsync(301);
    c.update({ query: 'two', scope: 'all', accountId: null });
    await vi.advanceTimersByTimeAsync(301);
    first.resolve({ hits: [hit('mail', 'a', 'stale')], hasMore: false });
    await vi.advanceTimersByTimeAsync(10);
    expect(c.getState().outcome.hits.mail.map((h) => h.id)).toEqual(['new']);
  });

  it('an empty query clears the outcome and never searches', async () => {
    const remote = vi.fn(async (): Promise<RemoteSearchResult> => ({ hits: [], hasMore: false }));
    const c = createGlobalSearchController({
      providers: [provider('mail', { remote })], accounts: () => [account('a')], localLimit: 5, remoteLimit: 5,
    });
    c.update({ query: '  ', scope: 'all', accountId: null });
    await vi.advanceTimersByTimeAsync(500);
    expect(c.getState().isEmpty).toBe(true);
    expect(remote).not.toHaveBeenCalled();
  });

  it('the scope chip applies unless the query has its own in:, and the account chip filters logins', async () => {
    const remote = vi.fn(async (_p: unknown, acc: SearchAccount): Promise<RemoteSearchResult> => ({ hits: [hit('files', acc.appAccountId, 'f')], hasMore: false }));
    const mail = vi.fn(async (): Promise<RemoteSearchResult> => ({ hits: [], hasMore: false }));
    const c = createGlobalSearchController({
      providers: [provider('files', { remote }), provider('mail', { remote: mail })],
      accounts: () => [account('a'), account('b')], localLimit: 5, remoteLimit: 5,
    });
    c.update({ query: 'x', scope: 'files', accountId: 'b' });
    await vi.advanceTimersByTimeAsync(301);
    expect(mail).not.toHaveBeenCalled();
    expect(remote).toHaveBeenCalledTimes(1);
    expect(c.getState().outcome.hits.files.map((h) => h.appAccountId)).toEqual(['b']);
    c.update({ query: 'in:mail x', scope: 'files', accountId: null });
    await vi.advanceTimersByTimeAsync(301);
    expect(mail).toHaveBeenCalledTimes(2);
  });

  it('a local cache that throws does not stop the server pass', async () => {
    const c = createGlobalSearchController({
      providers: [provider('mail', { local: () => { throw new Error('mid-mutation'); }, remote: async () => ({ hits: [hit('mail', 'a', 'm')], hasMore: false }) })],
      accounts: () => [account('a')], localLimit: 5, remoteLimit: 5,
    });
    c.update({ query: 'x', scope: 'all', accountId: null });
    await vi.advanceTimersByTimeAsync(301);
    expect(c.getState().outcome.hits.mail).toHaveLength(1);
  });

  it('loadMoreMail asks for a bigger window, merges it, and leaves other kinds alone', async () => {
    const limits: number[] = [];
    const mail = vi.fn(async (_p: unknown, _a: unknown, o: { limit: number }): Promise<RemoteSearchResult> => {
      limits.push(o.limit);
      const n = o.limit;
      return { hits: Array.from({ length: n }, (_, i) => hit('mail', 'a', `m${i}`)), hasMore: n < 6 };
    });
    const contacts = vi.fn(async (): Promise<RemoteSearchResult> => ({ hits: [hit('contacts', 'a', 'c1')], hasMore: false }));
    const c = createGlobalSearchController({
      providers: [provider('mail', { remote: mail as SearchProvider['remote'] }), provider('contacts', { remote: contacts })],
      accounts: () => [account('a')], localLimit: 5, remoteLimit: 3,
    });
    c.update({ query: 'x', scope: 'all', accountId: null });
    await vi.advanceTimersByTimeAsync(301);
    expect(c.getState().outcome.hits.mail).toHaveLength(3);
    expect(c.getState().outcome.status.mail.hasMore).toBe(true);
    c.loadMoreMail();
    await vi.advanceTimersByTimeAsync(10);
    expect(limits).toEqual([3, 6]);
    expect(c.getState().mailLimit).toBe(6);
    expect(c.getState().outcome.hits.mail).toHaveLength(6);
    expect(c.getState().outcome.status.mail.hasMore).toBe(false);
    expect(c.getState().outcome.hits.contacts).toHaveLength(1);
    expect(contacts).toHaveBeenCalledTimes(1);
    // A new query resets the window.
    c.update({ query: 'y', scope: 'all', accountId: null });
    expect(c.getState().mailLimit).toBe(3);
  });

  it('a load-more that lands after the query changed is dropped', async () => {
    const slow = deferred<RemoteSearchResult>();
    let calls = 0;
    const mail = vi.fn(async (): Promise<RemoteSearchResult> => {
      calls++;
      return calls === 2 ? slow.promise : { hits: [hit('mail', 'a', calls === 1 ? 'first' : 'second')], hasMore: true };
    });
    const c = createGlobalSearchController({
      providers: [provider('mail', { remote: mail })], accounts: () => [account('a')], localLimit: 5, remoteLimit: 3,
    });
    c.update({ query: 'x', scope: 'all', accountId: null });
    await vi.advanceTimersByTimeAsync(301);
    c.loadMoreMail();
    c.update({ query: 'y', scope: 'all', accountId: null });
    await vi.advanceTimersByTimeAsync(301);
    slow.resolve({ hits: [hit('mail', 'a', 'late')], hasMore: false });
    await vi.advanceTimersByTimeAsync(10);
    expect(c.getState().outcome.hits.mail.map((h) => h.id)).toEqual(['second']);
  });

  it('rerun repeats the server pass at once and dispose stops everything', async () => {
    const remote = vi.fn(async (): Promise<RemoteSearchResult> => ({ hits: [], hasMore: false }));
    const c = createGlobalSearchController({
      providers: [provider('mail', { remote })], accounts: () => [account('a')], localLimit: 5, remoteLimit: 5,
    });
    const listener = vi.fn();
    c.subscribe(listener);
    c.update({ query: 'x', scope: 'all', accountId: null });
    await vi.advanceTimersByTimeAsync(301);
    c.rerun();
    await vi.advanceTimersByTimeAsync(301);
    expect(remote).toHaveBeenCalledTimes(2);
    c.update({ query: 'z', scope: 'all', accountId: null });
    c.dispose();
    const seen = listener.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(remote).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls.length).toBe(seen);
  });
});
