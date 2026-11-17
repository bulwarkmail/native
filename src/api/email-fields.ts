import type { JMAPClient } from './jmap-client';
import type { Mailbox } from './types';
import type { RulePreviewTarget } from '../lib/sieve/rule-preview';
import { requireMethodResult } from './jmap-result';

type FieldsClient = Pick<JMAPClient, 'request' | 'accountId' | 'getMaxObjectsInGet'>;

export async function queryEmailFields(
  client: FieldsClient,
  filter: Record<string, unknown>,
  properties: string[],
  accountId?: string,
  limit = 10000,
): Promise<Array<Record<string, unknown>>> {
  const targetAccountId = accountId || client.accountId;
  const pageSize = Math.max(1, Math.min(500, client.getMaxObjectsInGet()));
  const seen = new Set<string>();
  const list: Array<Record<string, unknown>> = [];
  let position = 0;
  while (list.length < limit) {
    const requested = Math.min(pageSize, limit - list.length);
    const response = await client.request([
      ['Email/query', {
        accountId: targetAccountId,
        filter,
        sort: [{ property: 'receivedAt', isAscending: false }],
        position,
        limit: requested,
      }, '0'],
      ['Email/get', {
        accountId: targetAccountId,
        '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' },
        properties: ['id', ...properties],
      }, '1'],
    ]);
    const query = requireMethodResult<{ ids?: string[] }>(response, '0', 'Email/query');
    const got = requireMethodResult<{ list?: Array<Record<string, unknown>> }>(response, '1', 'Email/get');
    const ids = query.ids ?? [];
    for (const email of got.list ?? []) {
      const id = String(email.id);
      if (seen.has(id)) continue;
      seen.add(id);
      list.push(email);
    }
    if (ids.length < requested) break;
    position += ids.length;
  }
  return list;
}

export function ownMailTarget(client: FieldsClient, mailboxes: Mailbox[]): RulePreviewTarget {
  return {
    client: { queryEmailFields: (filter, properties, accountId, limit) => queryEmailFields(client, filter, properties, accountId, limit) },
    get accountId() { return client.accountId; },
    mailboxes,
  };
}
