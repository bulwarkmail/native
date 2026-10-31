import type { Mailbox } from '../api/types';

/** Roles a folder link may name instead of an id (webmail lib/deep-links.ts). */
const ALIASED_ROLES = new Set(['inbox', 'sent', 'drafts', 'trash', 'archive', 'junk']);

/**
 * The folder a `mail/folder/<ref>` link names: an exact id first, then a role
 * alias (the own account's folder before a shared one's). Null when nothing in
 * the loaded folders matches, a link to a folder that was deleted or lives in
 * another account (webmail resolveFolderRef).
 */
export function resolveFolderRef(ref: string, mailboxes: readonly Mailbox[]): string | null {
  if (mailboxes.some((m) => m.id === ref)) return ref;
  if (ALIASED_ROLES.has(ref)) {
    const byRole = mailboxes.find((m) => m.role === ref && !m.isShared)
      ?? mailboxes.find((m) => m.role === ref);
    return byRole?.id ?? null;
  }
  return null;
}
