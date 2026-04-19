import type { Mailbox } from '../api/types';

export interface MailboxNode extends Mailbox {
  children: MailboxNode[];
  depth: number;
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
// (e.g. "Sent Mail" when a role=sent mailbox already exists). Mirrors the
// webmail's `deduplicateMailboxes`; kept minimal (single account only).
function deduplicate(mailboxes: Mailbox[]): Mailbox[] {
  const roles = mailboxes.filter((m) => m.role);
  const referencedParentIds = new Set<string>();
  for (const m of mailboxes) {
    if (m.parentId) referencedParentIds.add(m.parentId);
  }

  const result: Mailbox[] = [];
  for (const m of mailboxes) {
    if (m.role) { result.push(m); continue; }
    if (m.parentId) { result.push(m); continue; }
    const lower = m.name.toLowerCase();
    const dup = roles.find((r) => {
      const rn = r.name.toLowerCase();
      return lower.includes(rn) || rn.includes(lower);
    });
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

export function buildMailboxTree(mailboxes: Mailbox[]): MailboxNode[] {
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

  const recalcDepths = (nodes: MailboxNode[], base: number) => {
    for (const n of nodes) {
      n.depth = base;
      if (n.children.length > 0) recalcDepths(n.children, base + 1);
    }
  };
  recalcDepths(roots, 0);
  sortNodes(roots);
  return roots;
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
