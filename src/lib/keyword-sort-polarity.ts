import AsyncStorage from '@react-native-async-storage/async-storage';
import { jmapClient } from '../api/jmap-client';
import { CAPABILITIES } from '../api/types';
import type { Email } from '../api/types';
import {
  buildEmailSort,
  hasKeywordLevels,
  type JMAPEmailComparator,
  type KeywordSortPolarity,
  type SortLevel,
} from './message-list-order';

// Port of the webmail's JMAPClient.resolveKeywordSortPolarity /
// probeKeywordSortPolarity / buildListSort (lib/jmap/client.ts). Stalwart
// inverts `isAscending` on hasKeyword comparators (#718), so the server is
// probed once per account and the verdict feeds buildEmailSort. Unlike the
// webmail, which lives in one long session, the app starts often: a
// conclusive verdict is stored per server and account and reused for a week
// (a server upgrade may change it), instead of probing on every start.

const KEYWORD_SORT_PROBE_RETRY_MS = 5 * 60 * 1000;
// Bump the version when the probe or what it decides changes.
const STORAGE_KEY = 'keyword-sort-polarity:v1';
const STORED_VERDICT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type StoredVerdict = { verdict: KeywordSortPolarity | 'unsupported'; at: number };
let stored: Record<string, StoredVerdict> = {};
let hydration: Promise<void> | null = null;

// Keyed by `<serverUrl>|<jmap account id>` so two logged-in accounts on the
// same server, or the same id on two servers, never share a verdict.
const polarityCache = new Map<string, { value: KeywordSortPolarity | null; at: number }>();
const probes = new Map<string, Promise<KeywordSortPolarity>>();
// Accounts whose server refused a hasKeyword comparator with unsupportedSort.
const unsupported = new Set<string>();

function cacheKey(accountId: string): string {
  return `${jmapClient.serverUrl ?? ''}|${accountId}`;
}

/** The server's advertised Email/query sort options, or null when unknown. */
function emailQuerySortOptions(accountId: string): string[] | null {
  const caps = jmapClient.currentSession?.accounts?.[accountId]?.accountCapabilities as
    | Record<string, { emailQuerySortOptions?: unknown }> | undefined;
  const options = caps?.[CAPABILITIES.MAIL]?.emailQuerySortOptions;
  return Array.isArray(options) ? options.filter((o): o is string => typeof o === 'string') : null;
}

/**
 * Whether keyword comparators can be sent to this account's server: not when
 * it advertises a sort-option list without them, and not after it refused one
 * with `unsupportedSort`. Unknown counts as yes.
 */
export function keywordSortSupported(accountId: string): boolean {
  if (unsupported.has(cacheKey(accountId))) return false;
  const options = emailQuerySortOptions(accountId);
  return options === null || options.includes('hasKeyword');
}

/** Remember that the server answered a keyword comparator with unsupportedSort. */
export function markKeywordSortUnsupported(accountId: string): void {
  const key = cacheKey(accountId);
  unsupported.add(key);
  store(key, 'unsupported');
}

/** Test hook: forgets the verdicts, stored ones too. */
export function resetKeywordSortState(): void {
  polarityCache.clear();
  probes.clear();
  unsupported.clear();
  stored = {};
  hydration = null;
  void AsyncStorage.removeItem(STORAGE_KEY).catch(() => undefined);
}

function isStoredVerdict(value: unknown): value is StoredVerdict {
  const v = value as StoredVerdict | null;
  return !!v && typeof v.at === 'number' && (v.verdict === 'rfc' || v.verdict === 'inverted' || v.verdict === 'unsupported');
}

// Load the stored verdicts once per launch; expired or unreadable ones are
// dropped and probed again.
function hydrateStoredVerdicts(): Promise<void> {
  hydration ??= (async () => {
    let raw: string | null = null;
    try {
      raw = await AsyncStorage.getItem(STORAGE_KEY);
    } catch {
      return;
    }
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    const now = Date.now();
    for (const [key, entry] of Object.entries((parsed ?? {}) as Record<string, unknown>)) {
      if (!isStoredVerdict(entry) || now - entry.at >= STORED_VERDICT_MAX_AGE_MS || entry.at > now) continue;
      stored[key] ??= entry;
      if (entry.verdict === 'unsupported') unsupported.add(key);
      else if (!polarityCache.has(key)) polarityCache.set(key, { value: entry.verdict, at: entry.at });
    }
  })();
  return hydration;
}

function store(key: string, verdict: StoredVerdict['verdict']): void {
  stored = { ...stored, [key]: { verdict, at: Date.now() } };
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(stored)).catch(() => undefined);
}

async function probeKeywordSortPolarity(accountId: string): Promise<KeywordSortPolarity | null> {
  const sortFor = (isAscending: boolean) => [
    { property: 'hasKeyword', keyword: '$seen', isAscending },
    { property: 'receivedAt', isAscending: false },
  ];
  const response = await jmapClient.request([
    ['Email/query', { accountId, sort: sortFor(true), limit: 1 }, 'asc'],
    ['Email/query', { accountId, sort: sortFor(false), limit: 1 }, 'desc'],
    ['Email/get', {
      accountId,
      '#ids': { resultOf: 'asc', name: 'Email/query', path: '/ids' },
      properties: ['id', 'keywords'],
    }, 'get'],
  ]);
  const [ascMethod, ascResult] = response.methodResponses?.[0] ?? [];
  if (ascMethod === 'error') {
    if ((ascResult as { type?: string })?.type === 'unsupportedSort') {
      markKeywordSortUnsupported(accountId);
      return 'rfc';
    }
    throw new Error((ascResult as { description?: string })?.description || 'Email/query failed');
  }
  const ascIds = ((ascResult as { ids?: string[] })?.ids) ?? [];
  const descIds = ((response.methodResponses?.[1]?.[1] as { ids?: string[] })?.ids) ?? [];
  // Same message both ways: the mailbox is homogeneous, probe inconclusive.
  if (ascIds.length === 0 || descIds.length === 0 || ascIds[0] === descIds[0]) return null;
  const first = ((response.methodResponses?.[2]?.[1] as { list?: Email[] })?.list ?? [])[0];
  if (!first || first.id !== ascIds[0]) return null;
  // Ascending put a $seen message first: the server sorts has-keyword first
  // on isAscending: true, the inverse of the RFC's false < true reading.
  return first.keywords?.$seen ? 'inverted' : 'rfc';
}

/**
 * Which way the server reads `isAscending` on hasKeyword comparators, probed
 * once per account (an inconclusive probe is retried after a few minutes; a
 * failed one falls back to the RFC reading without caching a verdict). A
 * conclusive verdict is stored and reused on later starts.
 */
export async function resolveKeywordSortPolarity(accountId: string): Promise<KeywordSortPolarity> {
  await hydrateStoredVerdicts();
  const key = cacheKey(accountId);
  const cached = polarityCache.get(key);
  if (cached && (cached.value !== null || Date.now() - cached.at < KEYWORD_SORT_PROBE_RETRY_MS)) {
    return Promise.resolve(cached.value ?? 'rfc');
  }
  const pending = probes.get(key);
  if (pending) return pending;
  const probe = probeKeywordSortPolarity(accountId)
    .then((value) => {
      polarityCache.set(key, { value, at: Date.now() });
      // An unsupportedSort answer was stored as such by the probe.
      if (value !== null && !unsupported.has(key)) store(key, value);
      return value ?? 'rfc';
    })
    .catch((error) => {
      console.warn('[keyword-sort] polarity probe failed:', error);
      polarityCache.set(key, { value: null, at: Date.now() });
      return 'rfc' as const;
    })
    .finally(() => {
      probes.delete(key);
    });
  probes.set(key, probe);
  return probe;
}

/**
 * The Email/query sort for a folder view with the server's polarity applied
 * (webmail `buildListSort`). `pinnedFirst` prepends the $pinned comparator;
 * `dateAscending` flips the trailing receivedAt tie-breaker (RN's
 * oldest-first toggle, native #5) when the order has no explicit date level.
 */
export async function buildListSort(
  accountId: string,
  order: SortLevel[],
  opts: { pinnedFirst?: boolean; dateAscending?: boolean } = {},
): Promise<JMAPEmailComparator[]> {
  const pinnedFirst = opts.pinnedFirst ?? true;
  let sort: JMAPEmailComparator[];
  if (hasKeywordLevels(order, pinnedFirst)) await hydrateStoredVerdicts();
  if (!hasKeywordLevels(order, pinnedFirst)) {
    sort = buildEmailSort(order);
  } else if (!keywordSortSupported(accountId)) {
    sort = buildEmailSort(order, { pinnedFirst, keywordSortSupported: false });
  } else {
    const polarity = await resolveKeywordSortPolarity(accountId);
    sort = buildEmailSort(order, { pinnedFirst, polarity, keywordSortSupported: keywordSortSupported(accountId) });
  }
  if (opts.dateAscending && !order.some((l) => l.criterion === 'receivedAt')) {
    sort = sort.map((cmp) => (cmp.property === 'receivedAt' ? { ...cmp, isAscending: true } : cmp));
  }
  return sort;
}
