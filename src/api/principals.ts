import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import type { Principal } from './types';

/** Safety bound on how many principals the share picker pages through. */
const MAX_PRINCIPALS = 20_000;

// List all principals visible to the user. Stalwart returns the full
// directory regardless of `filter`, so callers filter client-side. Paged by
// maxObjectsInGet: an unbounded query hands every id to the chained
// Principal/get, which the server refuses with `requestTooLarge` once the
// directory holds more than that (500), leaving the picker empty.
export async function getPrincipals(): Promise<Principal[]> {
  // Same gate as files.ts supportsSharing().
  if (!jmapClient.hasCapability(CAPABILITIES.PRINCIPALS)) return [];
  const accountId = jmapClient.accountId;
  const pageSize = jmapClient.getMaxObjectsInGet();
  const all: Principal[] = [];
  for (let position = 0; position < MAX_PRINCIPALS;) {
    const res = await jmapClient.request(
      [
        ['Principal/query', { accountId, position, limit: pageSize }, '0'],
        ['Principal/get', {
          accountId,
          '#ids': { resultOf: '0', name: 'Principal/query', path: '/ids' },
        }, '1'],
      ],
      [CAPABILITIES.CORE, CAPABILITIES.PRINCIPALS],
    );
    const ids = (res.methodResponses.find((r) => r[0] === 'Principal/query')?.[1].ids ?? []) as string[];
    const getResp = res.methodResponses.find((r) => r[0] === 'Principal/get');
    if (!getResp) break;
    all.push(...((getResp[1].list ?? []) as Principal[]));
    if (ids.length < pageSize) break;
    position += ids.length;
  }
  return all;
}
