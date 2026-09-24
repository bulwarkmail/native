import type { Mailbox } from '../api/types';

export interface MailboxNode extends Mailbox {
  children: MailboxNode[];
  depth: number;
  /**
   * True for the virtual node that wraps a shared/group account's folders.
   * It has no server-side mailbox behind it — it can be expanded but never
   * selected or used as a move target.
   */
  isAccountNode?: boolean;
}

// Id prefix for the virtual per-shared-account node. Matches the webmail's
// `shared-account-<accountId>` convention in [lib/utils.ts].
export const SHARED_ACCOUNT_NODE_PREFIX = 'shared-account-';

/** The user's own folders — everything not owned by a shared/group account. */
export function ownMailboxes(mailboxes: Mailbox[]): Mailbox[] {
  return mailboxes.filter((m) => !m.isShared);
}

/**
 * Folders belonging to the same account as `mailboxId`. Role lookups (trash,
 * archive, junk…) must run inside one account: moving a message out of a
 * shared folder into the user's own Trash isn't a thing JMAP can express.
 * Falls back to the user's own folders when the id isn't known.
 */
export function mailboxesForSiblingOf(mailboxes: Mailbox[], mailboxId: string | null): Mailbox[] {
  const current = mailboxId ? mailboxes.find((m) => m.id === mailboxId) : undefined;
  if (!current?.isShared) return ownMailboxes(mailboxes);
  return mailboxes.filter((m) => m.isShared && m.accountId === current.accountId);
}

/** The JMAP account a folder lives in: its owner when shared, undefined for the user's own. */
export function mailboxAccountId(mailboxes: Mailbox[], mailboxId: string | null): string | undefined {
  const mailbox = mailboxId ? mailboxes.find((m) => m.id === mailboxId) : undefined;
  return mailbox?.isShared ? mailbox.accountId : undefined;
}

/**
 * Folders of one JMAP account: the user's own for `undefined`, else that
 * shared account's. A message's role folders (trash, archive, junk…) must
 * come from the account it lives in, not from whatever folder is open —
 * ids are only unique per account. Empty when the account's folders are not
 * loaded, so callers refuse instead of guessing.
 */
export function mailboxesOfAccount(mailboxes: Mailbox[], accountId: string | undefined): Mailbox[] {
  if (!accountId) return ownMailboxes(mailboxes);
  return mailboxes.filter((m) => m.isShared && m.accountId === accountId);
}

/**
 * The folder a message is filed in among one account's `mailboxes`: the
 * preferred one (the folder it was opened from) when the message is in it,
 * otherwise the first of its folders that is known. `mailboxIds` comes from
 * the server unprefixed, so it is matched on each folder's raw id.
 */
export function mailboxOfEmail(
  mailboxes: Mailbox[],
  mailboxIds: Record<string, boolean> | undefined,
  preferredId?: string | null,
): Mailbox | undefined {
  const holds = (m: Mailbox) => !!mailboxIds?.[m.originalId ?? m.id];
  const preferred = preferredId ? mailboxes.find((m) => m.id === preferredId) : undefined;
  if (preferred && holds(preferred)) return preferred;
  return mailboxes.find(holds);
}

// Matches `ROLE_PRIORITY` from [lib/utils.ts] in the webmail.
const ROLE_PRIORITY: Record<string, number> = {
  inbox: 0,
  drafts: 1,
  sent: 2,
  archive: 3,
  junk: 4,
  spam: 4,
  trash: 5,
};

// Drop root-level folders whose name collides with an existing role mailbox
// (e.g. a plain "Sent" folder when a role=sent mailbox already exists).
// Mirrors the webmail's `deduplicateMailboxes`; kept minimal (single account
// only). Only an *exact* (trimmed, case-insensitive) name collision counts:
// substring matching silently hid legitimate user folders whose name merely
// contained a role folder's name — "Old Inbox", "2025 Archive",
// "Sent to Accounting" (GitHub #771).
function deduplicate(mailboxes: Mailbox[]): Mailbox[] {
  const roles = mailboxes.filter((m) => m.role);
  const referencedParentIds = new Set<string>();
  for (const m of mailboxes) {
    if (m.parentId) referencedParentIds.add(m.parentId);
  }

  const result: Mailbox[] = [];
  for (const m of mailboxes) {
    if (m.role) { result.push(m); continue; }
    // Never deduplicate nested folders — removing one would orphan its
    // children to the root (GitHub #118).
    if (m.parentId) { result.push(m); continue; }
    const lower = m.name.trim().toLowerCase();
    const dup = roles.find((r) => r.name.trim().toLowerCase() === lower);
    if (!dup || referencedParentIds.has(m.id)) result.push(m);
  }
  return result;
}

function sortNodes(nodes: MailboxNode[]): void {
  nodes.sort((a, b) => {
    const ap = a.role ? (ROLE_PRIORITY[a.role] ?? 999) : 999;
    const bp = b.role ? (ROLE_PRIORITY[b.role] ?? 999) : 999;
    if (ap !== bp) return ap - bp;
    const ao = a.sortOrder ?? 0;
    const bo = b.sortOrder ?? 0;
    if (ao !== bo) return ao - bo;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) sortNodes(node.children);
}

function recalcDepths(nodes: MailboxNode[], base: number): void {
  for (const n of nodes) {
    n.depth = base;
    if (n.children.length > 0) recalcDepths(n.children, base + 1);
  }
}

// Build the root nodes for one account's folders (parent links only resolve
// within an account — a shared folder can't nest under an own folder).
function buildRoots(mailboxes: Mailbox[]): MailboxNode[] {
  const deduped = deduplicate(mailboxes);
  const map = new Map<string, MailboxNode>();
  const roots: MailboxNode[] = [];

  for (const m of deduped) {
    map.set(m.id, { ...m, children: [], depth: 0 });
  }
  for (const m of deduped) {
    const node = map.get(m.id)!;
    if (m.parentId && map.has(m.parentId)) {
      map.get(m.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

const ACCOUNT_NODE_RIGHTS: Mailbox['myRights'] = {
  mayReadItems: true,
  mayAddItems: false,
  mayRemoveItems: false,
  maySetSeen: false,
  maySetKeywords: false,
  mayCreateChild: false,
  mayRename: false,
  mayDelete: false,
  maySubmit: false,
};

/**
 * Own folders first, then one collapsible node per shared/group account
 * holding that account's folders — the same shape the webmail sidebar uses
 * (GitHub #151), so a Stalwart group mailbox shows up as its own section
 * rather than being mixed into the user's folder list.
 */
export function buildMailboxTree(
  mailboxes: Mailbox[],
  opts: {
    /**
     * Role folders to leave out of the user's own tree — e.g. the server's
     * `scheduled` folder while the virtual Scheduled row is shown (#495).
     */
    hideOwnRoles?: ReadonlySet<string>;
  } = {},
): MailboxNode[] {
  const own = mailboxes.filter((m) => !m.isShared && !(m.role && opts.hideOwnRoles?.has(m.role)));
  const shared = mailboxes.filter((m) => m.isShared);

  const roots = buildRoots(own);
  recalcDepths(roots, 0);
  sortNodes(roots);

  if (shared.length === 0) return roots;

  const byAccount = new Map<string, Mailbox[]>();
  for (const m of shared) {
    const accountId = m.accountId ?? 'unknown';
    const list = byAccount.get(accountId);
    if (list) list.push(m);
    else byAccount.set(accountId, [m]);
  }

  const accountNodes: MailboxNode[] = [];
  for (const [accountId, accountMailboxes] of byAccount) {
    const accountRoots = buildRoots(accountMailboxes);
    // Children sit at depth 1 so the account node reads as their header.
    recalcDepths(accountRoots, 1);
    sortNodes(accountRoots);

    const accountName = accountMailboxes[0]?.accountName || accountId;
    accountNodes.push({
      id: `${SHARED_ACCOUNT_NODE_PREFIX}${accountId}`,
      name: accountName,
      sortOrder: 1000,
      totalEmails: 0,
      // Roll the account's unread up to the header so a collapsed section
      // still shows there's something waiting.
      unreadEmails: accountMailboxes.reduce((sum, m) => sum + (m.unreadEmails ?? 0), 0),
      totalThreads: 0,
      unreadThreads: 0,
      myRights: ACCOUNT_NODE_RIGHTS,
      isSubscribed: true,
      accountId,
      accountName,
      isShared: true,
      isAccountNode: true,
      children: accountRoots,
      depth: 0,
    });
  }
  accountNodes.sort((a, b) => a.name.localeCompare(b.name));

  return [...roots, ...accountNodes];
}

/** Every folder below `mailboxId` (any depth) plus the folder itself. */
export function mailboxSubtreeIds(mailboxes: Mailbox[], mailboxId: string): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const m of mailboxes) {
    if (!m.parentId) continue;
    const list = childrenOf.get(m.parentId);
    if (list) list.push(m.id);
    else childrenOf.set(m.parentId, [m.id]);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
    for (const child of childrenOf.get(id) ?? []) walk(child);
  };
  walk(mailboxId);
  return out;
}

// Flatten the tree in traversal order, skipping children of collapsed nodes.
export function flattenVisible(
  nodes: MailboxNode[],
  expanded: Set<string>,
): MailboxNode[] {
  const out: MailboxNode[] = [];
  const walk = (list: MailboxNode[]) => {
    for (const n of list) {
      out.push(n);
      if (n.children.length > 0 && expanded.has(n.id)) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

export function findTrashMailbox(mailboxes: Mailbox[]): Mailbox | undefined {
  const roleMatch = mailboxes.find((m) => m.role === 'trash');
  if (roleMatch) return roleMatch;

  const names = ['trash', 'bin', 'deleted', 'deleted items', 'corbeille', 'messages supprimés', 'éléments supprimés', 'supprimé', 'supprimés'];
  return mailboxes.find((m) => {
    const lower = m.name.toLowerCase();
    return names.includes(lower) || names.some((n) => lower.includes(n));
  });
}

export function findArchiveMailbox(mailboxes: Mailbox[]): Mailbox | undefined {
  const roleMatch = mailboxes.find((m) => m.role === 'archive');
  if (roleMatch) return roleMatch;

  const names = ['archive', 'archives', 'archived'];
  return mailboxes.find((m) => {
    const lower = m.name.toLowerCase();
    return names.includes(lower) || names.some((n) => lower.includes(n));
  });
}

export function findJunkMailbox(mailboxes: Mailbox[]): Mailbox | undefined {
  const roleMatch = mailboxes.find((m) => m.role === 'junk' || m.role === 'spam');
  if (roleMatch) return roleMatch;

  const names = ['junk', 'spam', 'indésirables', 'indésirable', 'courrier indésirable'];
  return mailboxes.find((m) => {
    const lower = m.name.toLowerCase();
    return names.includes(lower) || names.some((n) => lower.includes(n));
  });
}
