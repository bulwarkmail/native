import { jmapClient } from './jmap-client';
import { requireMethodResult } from './jmap-result';
import { extractListId, unfoldHeader } from '../lib/filters/quick-rules';

/**
 * The List-Id of messages that were listed without their headers. Only that
 * header is asked for, and the account is always the caller's: ids repeat
 * across accounts. Stalwart parses List-Id as a structured header and answers
 * the text form with null, so the raw form is asked for too (webmail's
 * loadListIds). A message without the header maps to null; a failed request
 * throws, and the caller then offers no list preset.
 */
export async function fetchListIds(
  emailIds: string[],
  accountId: string,
): Promise<Map<string, string | null>> {
  const found = new Map<string, string | null>();
  const unique = [...new Set(emailIds)];
  const size = Math.max(1, jmapClient.getMaxObjectsInGet());
  for (let i = 0; i < unique.length; i += size) {
    const ids = unique.slice(i, i + size);
    const res = await jmapClient.request([
      ['Email/get', {
        accountId,
        ids,
        properties: ['id', 'header:List-Id:asText', 'header:List-Id'],
      }, '0'],
    ]);
    const list = (requireMethodResult(res, '0', 'Email/get').list as Array<Record<string, unknown>> | undefined) ?? [];
    for (const record of list) {
      found.set(
        String(record.id),
        extractListId(record['header:List-Id:asText'] ?? unfoldHeader(record['header:List-Id'])),
      );
    }
    for (const id of ids) if (!found.has(id)) found.set(id, null);
  }
  return found;
}
