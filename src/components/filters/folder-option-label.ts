import { localizeMailboxName } from '../../lib/mailbox-label';
import type { MailboxTarget } from '../../lib/sieve/rule-actions';
import type { Mailbox } from '../../api/types';

type Translate = (key: string, fallback?: string) => string;

/**
 * A filter rule's folder picker row: the folder's indent and its name as the
 * rest of the app shows it. The targets carry the server name, so system
 * folders read "Sent Items", "Junk Mail" or "Deleted Items" here and
 * "Sent", "Spam" or "Trash" everywhere else. The rule itself keeps the
 * server path (fileinto needs it); only the label changes.
 */
export function folderOptionLabel(
  target: MailboxTarget,
  mailbox: Pick<Mailbox, 'role' | 'name'> | undefined,
  t: Translate,
): string {
  if (!mailbox?.role) return target.label;
  const indent = /^ */.exec(target.label)?.[0] ?? '';
  return indent + localizeMailboxName(mailbox.role, mailbox.name, t);
}

/** Mailboxes by the id the targets use (the server id of a shared folder). */
export function mailboxesByTargetId(mailboxes: Mailbox[]): Map<string, Mailbox> {
  return new Map(mailboxes.map((m) => [m.originalId ?? m.id, m]));
}
