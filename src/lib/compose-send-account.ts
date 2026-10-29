// Where the composer creates, submits and files a message: the account its
// From belongs to (#1090). A group or shared identity sends from the group's
// account, with that account's identity id, and its draft and Sent copy live
// in the group's Drafts and Sent; everything else uses the login's own.

import { getMailboxes } from '../api/email';
import { jmapClient } from '../api/jmap-client';
import { resolveSendAccountId, sendIdentityIn } from '../api/identity';
import type { Identity, Mailbox } from '../api/types';
import { mailboxesOfAccount } from './mailbox-tree';

export interface SendTarget {
  /** The JMAP account; undefined for the login's own. */
  accountId?: string;
  /** The identity to submit through, as that account names it. */
  identityId: string;
  draftsMailboxId?: string;
  sentMailboxId?: string;
}

const roleIn = (list: Mailbox[], role: string) => {
  const box = list.find((m) => m.role === role);
  return box ? (box.originalId ?? box.id) : undefined;
};

/**
 * The account, identity and folders for a message From `fromEmail` that the
 * composer picked `identity` (one of the login's own) for. `mailboxes` are
 * the folders the app has loaded, the shared ones among them; a group's are
 * read from the server when they are not.
 */
export async function sendTargetFor(identity: Identity, fromEmail: string, mailboxes: Mailbox[]): Promise<SendTarget> {
  const ownTarget: SendTarget = {
    identityId: identity.id,
    draftsMailboxId: roleIn(mailboxesOfAccount(mailboxes, undefined), 'drafts'),
    sentMailboxId: roleIn(mailboxesOfAccount(mailboxes, undefined), 'sent'),
  };
  const accountId = await resolveSendAccountId(fromEmail);
  if (accountId === jmapClient.accountId) return ownTarget;
  // Submitting needs the account's own identity for the address; without
  // one, the message goes out of the login's account as before.
  let accountIdentity: Identity | undefined;
  try {
    accountIdentity = await sendIdentityIn(accountId, fromEmail);
  } catch (err) {
    console.warn('[compose] could not read the identities of the sending account', err);
  }
  if (!accountIdentity) return ownTarget;
  let scope = mailboxesOfAccount(mailboxes, accountId);
  if (!scope.some((m) => m.role === 'sent')) {
    try {
      scope = await getMailboxes(accountId);
    } catch (err) {
      console.warn('[compose] could not read the folders of the sending account', err);
      return ownTarget;
    }
  }
  const sentMailboxId = roleIn(scope, 'sent');
  if (!sentMailboxId) return ownTarget;
  return { accountId, identityId: accountIdentity.id, draftsMailboxId: roleIn(scope, 'drafts'), sentMailboxId };
}
