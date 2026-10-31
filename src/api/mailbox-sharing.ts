// Sharing a mail folder with other principals
// (urn:ietf:params:jmap:mail:share), as the webmail's
// JMAPClient.getMailboxShareWith / setMailboxShare do (lib/jmap/client.ts).

import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import { requireMethodResult } from './jmap-result';
import { MAIL_SHARE_CAPABILITY } from './delegation';
import type { ShareMailboxRights } from '../lib/delegation/share-rights';

const USING = [CAPABILITIES.CORE, CAPABILITIES.MAIL, MAIL_SHARE_CAPABILITY];

/**
 * The current `shareWith` of one folder. Read on demand (the share sheet):
 * Stalwart leaves shareWith out of Mailbox/get unless it is asked for.
 * `accountId` is the owner's account for a folder someone shared with the
 * user, with the owner's mailbox id.
 */
export async function getMailboxShareWith(
  mailboxId: string,
  accountId?: string,
): Promise<Record<string, ShareMailboxRights> | null> {
  const res = await jmapClient.request(
    [['Mailbox/get', { accountId: accountId || jmapClient.accountId, ids: [mailboxId], properties: ['id', 'shareWith'] }, '0']],
    USING,
  );
  const result = requireMethodResult<{ list?: Array<{ id: string; shareWith?: Record<string, ShareMailboxRights> | null }> }>(
    res, '0', 'Mailbox/get',
  );
  const mailbox = (result.list ?? []).find((mb) => mb.id === mailboxId);
  if (!mailbox) throw new Error('Folder not found');
  return mailbox.shareWith ?? null;
}

/**
 * Grants (`rights`) or revokes (`null`) a principal's access to a folder with
 * a `shareWith/{principalId}` patch, like the calendar and address book
 * shares.
 */
export async function setMailboxShare(
  mailboxId: string,
  principalId: string,
  rights: ShareMailboxRights | null,
  accountId?: string,
): Promise<void> {
  const res = await jmapClient.request(
    [['Mailbox/set', {
      accountId: accountId || jmapClient.accountId,
      update: { [mailboxId]: { [`shareWith/${principalId}`]: rights } },
    }, '0']],
    USING,
  );
  const result = requireMethodResult<{
    updated?: Record<string, unknown> | null;
    notUpdated?: Record<string, { description?: string; type?: string }>;
  }>(res, '0', 'Mailbox/set');
  const err = result.notUpdated?.[mailboxId];
  if (err) throw new Error(err.description || err.type || 'Failed to update folder share');
  if (!result.updated || !(mailboxId in result.updated)) {
    throw new Error('Server did not confirm the share update');
  }
}
