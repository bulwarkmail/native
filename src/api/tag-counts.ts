import { jmapClient } from './jmap-client';
import type { JMAPMethodCall } from './types';

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
 */
export async function fetchTagCounts(
  tagIds: string[],
  accountIds: Array<string | undefined> = [undefined],
): Promise<TagCount[]> {
  if (tagIds.length === 0) return [];
  const perRequest = Math.max(2, jmapClient.getMaxCallsInRequest());
  const counts = new Map<string, TagCount>(tagIds.map((id) => [id, { id, total: 0, unread: 0 }]));

  const calls: JMAPMethodCall[] = [];
  const targets = new Map<string, { id: string; kind: 'total' | 'unread' }>();
  accountIds.forEach((override, index) => {
    const accountId = override ?? jmapClient.accountId;
    for (const id of tagIds) {
      const keyword = `$label:${id}`;
      targets.set(`t${index}:${id}`, { id, kind: 'total' });
      calls.push(['Email/query', {
        accountId,
        filter: { hasKeyword: keyword },
        limit: 0,
        calculateTotal: true,
      }, `t${index}:${id}`]);
      targets.set(`u${index}:${id}`, { id, kind: 'unread' });
      calls.push(['Email/query', {
        accountId,
        filter: { operator: 'AND', conditions: [{ hasKeyword: keyword }, { notKeyword: '$seen' }] },
        limit: 0,
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
