import { jmapClient } from './jmap-client';
import { SUBMISSION_ONLY_USING } from './submissions';

/**
 * Ids of a conversation's messages that wait for a scheduled send: a pending
 * EmailSubmission whose send time is still ahead. The conversation hides
 * Reply on them and points the quick reply past them, as it does for drafts
 * (webmail 8b29254a6, #1404). Empty when the account can't schedule or the
 * server can't answer: the cards then stay as they were.
 */
export async function scheduledEmailIdsInThread(threadId: string, accountId?: string): Promise<Set<string>> {
  const account = accountId ?? jmapClient.accountId;
  if (!account || !jmapClient.hasDelayedSend(account)) return new Set();
  try {
    const res = await jmapClient.request([
      ['EmailSubmission/query', { accountId: account, filter: { threadIds: [threadId], undoStatus: 'pending' } }, '0'],
      ['EmailSubmission/get', {
        accountId: account,
        '#ids': { resultOf: '0', name: 'EmailSubmission/query', path: '/ids' },
        properties: ['emailId', 'sendAt', 'undoStatus'],
      }, '1'],
    ], SUBMISSION_ONLY_USING);
    const [name, body] = res.methodResponses?.[1] ?? [];
    if (name !== 'EmailSubmission/get') return new Set();
    const now = Date.now();
    const ids = new Set<string>();
    for (const s of (body.list as Array<{ emailId?: string; sendAt?: string; undoStatus?: string }>) ?? []) {
      if (!s.emailId || s.undoStatus !== 'pending') continue;
      const at = s.sendAt ? new Date(s.sendAt).getTime() : NaN;
      if (Number.isFinite(at) && at > now) ids.add(s.emailId);
    }
    return ids;
  } catch {
    return new Set();
  }
}
