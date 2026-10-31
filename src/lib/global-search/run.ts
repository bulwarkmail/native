import { accountMatches, hasRemoteQuery, type ParsedQuery, type SearchKind } from './query-parser';
import { mergeHits, rankHits } from './rank';
import { emptyOutcome, type SearchAccount, type SearchOutcome, type SearchProvider } from './types';

// The fan-out of one search (webmail lib/global-search/run-global-search.ts).

export interface RunGlobalSearchOptions {
  parsed: ParsedQuery;
  accounts: SearchAccount[];
  providers: readonly SearchProvider[];
  localLimit: number;
  remoteLimit: number;
  signal: AbortSignal;
  /** A fresh snapshot each time hits or statuses change; never after `signal` aborts. */
  onUpdate: (outcome: SearchOutcome) => void;
  concurrency?: number;
  timeoutMs?: number;
  includeLocal?: boolean;
}

export const DEFAULT_SEARCH_CONCURRENCY = 4;
export const DEFAULT_SEARCH_TIMEOUT_MS = 8000;

function snapshot(outcome: SearchOutcome): SearchOutcome {
  const status = {} as SearchOutcome['status'];
  for (const kind of Object.keys(outcome.status) as SearchKind[]) {
    status[kind] = { ...outcome.status[kind], errors: [...outcome.status[kind].errors] };
  }
  return { hits: { ...outcome.hits }, status };
}

/** The pass over what is in memory, before any request goes out. */
export function localOutcome(
  parsed: ParsedQuery,
  accounts: SearchAccount[],
  providers: readonly SearchProvider[],
  limit: number,
): SearchOutcome {
  const outcome = emptyOutcome();
  const matching = accounts.filter((a) => accountMatches(parsed.account, a));
  for (const provider of providers) {
    if (parsed.scope !== 'all' && provider.kind !== parsed.scope) continue;
    if (parsed.terms.length > 0) {
      try {
        outcome.hits[provider.kind] = rankHits(mergeHits([], provider.local(parsed, matching, limit)), parsed);
      } catch {
        // A store in the middle of a change must not break typing.
      }
    }
    const willAsk = hasRemoteQuery(parsed, provider.kind) && matching.length > 0;
    outcome.status[provider.kind].status = willAsk ? 'loading' : 'done';
  }
  return outcome;
}

/**
 * Fans a parsed query out to every provider and login, publishing partial
 * results as they land: the in-memory hits first, then each server answer
 * merged, de-duplicated and re-ranked. A login that fails or times out
 * becomes an error row; the others still show.
 */
export async function runGlobalSearch(options: RunGlobalSearchOptions): Promise<SearchOutcome> {
  const {
    parsed, providers, signal, onUpdate, localLimit, remoteLimit,
    concurrency = DEFAULT_SEARCH_CONCURRENCY,
    timeoutMs = DEFAULT_SEARCH_TIMEOUT_MS,
    includeLocal = true,
  } = options;
  const accounts = options.accounts.filter((account) => accountMatches(parsed.account, account));
  const outcome = includeLocal ? localOutcome(parsed, accounts, providers, localLimit) : emptyOutcome();
  const publish = () => {
    if (!signal.aborted) onUpdate(snapshot(outcome));
  };

  const active = providers.filter((p) => parsed.scope === 'all' || p.kind === parsed.scope);
  type Task = { provider: SearchProvider; account: SearchAccount };
  const tasks: Task[] = [];
  const pending = new Map<SearchKind, number>();
  for (const provider of active) {
    const targets = hasRemoteQuery(parsed, provider.kind) ? accounts : [];
    pending.set(provider.kind, targets.length);
    outcome.status[provider.kind].status = targets.length > 0 ? 'loading' : 'done';
    for (const account of targets) tasks.push({ provider, account });
  }
  publish();

  const runTask = async ({ provider, account }: Task) => {
    const { kind } = provider;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    // Not every request takes a signal: race it against the abort.
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    try {
      const result = await Promise.race([
        provider.remote(parsed, account, { limit: remoteLimit, signal: controller.signal }),
        aborted,
      ]);
      if (signal.aborted) return;
      outcome.hits[kind] = rankHits(mergeHits(outcome.hits[kind], result.hits), parsed);
      if (result.hasMore) outcome.status[kind].hasMore = true;
    } catch (error) {
      if (signal.aborted) return;
      outcome.status[kind].errors.push({
        localAccountId: account.localAccountId,
        accountLabel: account.label,
        message: timedOut ? 'timeout' : error instanceof Error ? error.message : String(error),
      });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      const left = (pending.get(kind) ?? 1) - 1;
      pending.set(kind, left);
      if (left <= 0) outcome.status[kind].status = 'done';
      publish();
    }
  };

  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, async () => {
    while (next < tasks.length && !signal.aborted) {
      const task = tasks[next++];
      await runTask(task);
    }
  });
  await Promise.all(workers);
  return snapshot(outcome);
}
