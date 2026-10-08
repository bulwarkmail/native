// The folder in a `/mail/folder/<ref>` link (webmail lib/deep-links.ts
// `resolveFolderRef`). Pure, so it is tested without the stores.
import type { Mailbox } from '../api/types';
import { ownMailboxes } from './mailbox-tree';

type UnifiedRole = 'inbox' | 'sent' | 'drafts' | 'junk' | 'archive' | 'trash';
type UnifiedView = 'all' | 'unread' | 'starred';

export type VirtualFolderTarget =
  | { kind: 'scheduled' }
  | { kind: 'unified'; role?: UnifiedRole; view?: UnifiedView };

// The webmail's readable aliases for views with no server-side folder.
const VIRTUAL_FOLDER_ALIASES: Record<string, VirtualFolderTarget> = {
  scheduled: { kind: 'scheduled' },
  'unified-inbox': { kind: 'unified', role: 'inbox' },
  'unified-sent': { kind: 'unified', role: 'sent' },
  'unified-drafts': { kind: 'unified', role: 'drafts' },
  'unified-trash': { kind: 'unified', role: 'trash' },
  'unified-archive': { kind: 'unified', role: 'archive' },
  'unified-junk': { kind: 'unified', role: 'junk' },
  'cross-unread': { kind: 'unified', view: 'unread' },
  'cross-starred': { kind: 'unified', view: 'starred' },
  'cross-all': { kind: 'unified', view: 'all' },
};

/** Roles a link names by their role instead of their opaque id. */
const ALIASED_ROLES = new Set(['inbox', 'sent', 'drafts', 'trash', 'archive', 'junk']);

/** The view a virtual alias (`unified-inbox`, `cross-unread`, `scheduled`) opens, or null. */
export function virtualFolderTarget(ref: string): VirtualFolderTarget | null {
  return Object.prototype.hasOwnProperty.call(VIRTUAL_FOLDER_ALIASES, ref) ? VIRTUAL_FOLDER_ALIASES[ref] : null;
}

/** An own folder by its names from the top (`Projects/2026`). */
function findByPath(ref: string, mailboxes: Mailbox[]): Mailbox | undefined {
  const names = ref.split('/').filter(Boolean);
  if (names.length === 0) return undefined;
  const own = ownMailboxes(mailboxes);
  let parent: string | null = null;
  let found: Mailbox | undefined;
  for (const name of names) {
    found = own.find((m) => (m.parentId ?? null) === parent && m.name === name);
    if (!found) return undefined;
    parent = found.id;
  }
  return found;
}

/**
 * The store id of the folder `ref` names in `mailboxes`, one account's list:
 * an exact id first (so a folder whose id reads like a role is still
 * itself), then a role (the account's own folder before a shared copy), then
 * a path of own folder names. A shared folder is named by its namespaced
 * store id (`<accountId>:<rawId>`, what the webmail's links carry), so its
 * raw id never reaches it. Null when nothing matches.
 */
export function resolveFolderRef(ref: string, mailboxes: Mailbox[]): string | null {
  if (!ref) return null;
  if (mailboxes.some((m) => m.id === ref)) return ref;
  if (ALIASED_ROLES.has(ref)) {
    const byRole = mailboxes.find((m) => m.role === ref && !m.isShared)
      ?? mailboxes.find((m) => m.role === ref);
    return byRole?.id ?? null;
  }
  return findByPath(ref, mailboxes)?.id ?? null;
}
