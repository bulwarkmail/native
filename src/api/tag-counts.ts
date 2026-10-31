import { jmapClient } from './jmap-client';
import { CAPABILITIES, type JMAPMethodCall } from './types';

/** Bulwark's keyword counters (webmail lib/jmap/client.ts KEYWORDS_CAPABILITY). */
export const KEYWORDS_CAPABILITY = 'https://bulwarkmail.com/ns/jmap/keywords';

export interface TagCount {
  /** Tag id (the part after `$label:`). */
  id: string;
  total: number;
  unread: number;
}

/**
 * Unread/total counts per tag across every folder of the given JMAP accounts
 * (undefined = the user's own), summed: a tag sits on messages in the own and
 * in the shared (group) accounts alike, and its view lists all of them
 * (#1038). Two `Email/query` calls (`calculateTotal`, `limit: 0`) per tag and
 * account, packed into as few requests as the server's maxCallsInRequest
 * allows. Port of the webmail's `fetchTagCounts` (stores/email-store.ts). A
 * call that fails, such as for an account that can't be reached, counts 0
 * rather than sinking the rest.
 *
 * `excluded` names each account's Trash and Junk (key '' = the own account):
 * the counts leave them out like the tag view does (webmail #1156). An
 * account whose server counts keywords itself (Bulwark's keywords capability
 * with `supportsCounts`) is asked once with Keyword/get instead (#1399); its
 * counters cover the whole account, as the webmail's do.
 */
export async function fetchTagCounts(
  tagIds: string[],
  accountIds: Array<string | undefined> = [undefined],
  excluded: Record<string, string[]> = {},
): Promise<TagCount[]> {
  if (tagIds.length === 0) return [];
  const perRequest = Math.max(2, jmapClient.getMaxCallsInRequest());
  const counts = new Map<string, TagCount>(tagIds.map((id) => [id, { id, total: 0, unread: 0 }]));

  const queried: Array<string | undefined> = [];
  for (const override of accountIds) {
    const counted = countsKeywords(override ?? jmapClient.accountId)
      ? await tagCountsFromKeywords(tagIds, override ?? jmapClient.accountId)
      : null;
    if (!counted) {
      queried.push(override);
      continue;
    }
    for (const c of counted) {
      const entry = counts.get(c.id)!;
      entry.total += c.total;
      entry.unread += c.unread;
    }
  }

  const calls: JMAPMethodCall[] = [];
  const targets = new Map<string, { id: string; kind: 'total' | 'unread' }>();
  queried.forEach((override, index) => {
    const accountId = override ?? jmapClient.accountId;
    const skip = excluded[override ?? ''] ?? [];
    const exclusion = skip.length > 0 ? [{ inMailboxOtherThan: skip }] : [];
    for (const id of tagIds) {
      const keyword = `$label:${id}`;
      targets.set(`t${index}:${id}`, { id, kind: 'total' });
      calls.push(['Email/query', {
        accountId,
        filter: exclusion.length > 0
          ? { operator: 'AND', conditions: [{ hasKeyword: keyword }, ...exclusion] }
          : { hasKeyword: keyword },
        // 1, not 0: Stalwart takes 0 as "no limit" and returns every id.
        limit: 1,
        calculateTotal: true,
      }, `t${index}:${id}`]);
      targets.set(`u${index}:${id}`, { id, kind: 'unread' });
      calls.push(['Email/query', {
        accountId,
        filter: { operator: 'AND', conditions: [{ hasKeyword: keyword }, { notKeyword: '$seen' }, ...exclusion] },
        limit: 1,
        calculateTotal: true,
      }, `u${index}:${id}`]);
    }
  });

  for (let i = 0; i < calls.length; i += perRequest) {
    const res = await jmapClient.request(calls.slice(i, i + perRequest));
    for (const [name, body, callId] of res.methodResponses) {
      if (name !== 'Email/query' || typeof callId !== 'string') continue;
      const target = targets.get(callId);
      const entry = target ? counts.get(target.id) : undefined;
      if (!target || !entry) continue;
      const total = typeof body.total === 'number' ? body.total : 0;
      if (target.kind === 'total') entry.total += total;
      else entry.unread += total;
    }
  }
  return tagIds.map((id) => counts.get(id)!);
}

/** Whether the server reports every keyword's total and unread in Keyword/get. */
function countsKeywords(accountId: string): boolean {
  const capability = jmapClient.currentSession?.capabilities?.[KEYWORDS_CAPABILITY] as { supportsCounts?: unknown } | undefined;
  return capability?.supportsCounts === true && jmapClient.hasAccountCapability(KEYWORDS_CAPABILITY, accountId);
}

/** Counts from the server's keyword counters, or null so the caller queries instead. */
async function tagCountsFromKeywords(tagIds: string[], accountId: string): Promise<TagCount[] | null> {
  try {
    const res = await jmapClient.request(
      [['Keyword/get', { accountId, ids: tagIds.map((id) => `$label:${id}`) }, '0']],
      [CAPABILITIES.CORE, KEYWORDS_CAPABILITY],
    );
    const [name, body] = res.methodResponses?.[0] ?? [];
    if (name !== 'Keyword/get' || !Array.isArray(body?.list)) return null;
    // Keywords are case-insensitive (RFC 8621 4.1.1).
    const byId = new Map((body.list as Array<{ id: string; total?: number; unread?: number }>)
      .map((k) => [k.id.toLowerCase(), k]));
    return tagIds.map((id) => {
      const k = byId.get(`$label:${id}`.toLowerCase());
      return { id, total: k?.total ?? 0, unread: k?.unread ?? 0 };
    });
  } catch {
    return null;
  }
}
