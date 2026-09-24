import type { Mailbox } from '../../api/types';
import { buildMailboxTree, type MailboxNode } from '../mailbox-tree';
import type { FilterAction, FilterActionType } from './types';

// Editing helpers for the rule editor's action rows, ported from the
// webmail's components/filters/filter-rule-modal.tsx (dadfb08f). Kept out of
// the component so the folder-id bookkeeping can be tested on its own.

export const ACTIONS_WITH_VALUE = new Set<FilterActionType>(['move', 'copy', 'forward', 'reject', 'add_label']);
export const ACTIONS_WITH_MAILBOX = new Set<FilterActionType>(['move', 'copy']);

export interface MailboxTarget {
  /** JMAP id of the folder, what `fileinto :mailboxid` targets. */
  id: string;
  /** Sieve folder path, the fallback when the id no longer exists. */
  path: string;
  label: string;
}

/**
 * Flatten the mailbox tree into pickable targets, building the Sieve-canonical
 * folder path for each (inbox -> "INBOX", not the localized display name).
 * A shared account's folders carry their JMAP id in `originalId`.
 */
export function buildMailboxTargets(mailboxes: Mailbox[]): MailboxTarget[] {
  const targets: MailboxTarget[] = [];
  const walk = (nodes: MailboxNode[], parentPath: string) => {
    for (const node of nodes) {
      const segment = node.role === 'inbox' ? 'INBOX' : node.name;
      const path = parentPath ? `${parentPath}/${segment}` : segment;
      targets.push({
        id: node.originalId ?? node.id,
        path,
        label: `${' '.repeat(node.depth * 3)}${node.name}`,
      });
      if (node.children.length > 0) walk(node.children, path);
    }
  };
  walk(buildMailboxTree(mailboxes), '');
  return targets;
}

/**
 * Target folder id of a move/copy action. Rules saved before folder ids were
 * stored only carry the path, so resolve it; '' when nothing matches.
 */
export function mailboxIdFor(action: FilterAction, targets: MailboxTarget[]): string {
  if (action.mailboxId) return action.mailboxId;
  return targets.find((t) => t.path === action.value)?.id ?? '';
}

/**
 * Apply an edit to an action row. Fields the (new) type doesn't use are
 * dropped, and a row switched to move/copy starts on the first folder.
 */
export function updateFilterAction(
  action: FilterAction,
  updates: Partial<FilterAction>,
  targets: MailboxTarget[],
): FilterAction {
  const updated: FilterAction = { ...action, ...updates };
  if (updates.type && !ACTIONS_WITH_VALUE.has(updates.type)) delete updated.value;
  if (updates.type && !ACTIONS_WITH_MAILBOX.has(updates.type)) delete updated.mailboxId;
  if (updates.type && updates.type !== 'forward') delete updated.keepCopy;
  if (!updated.mailboxId) delete updated.mailboxId;
  if (!updated.keepCopy) delete updated.keepCopy;
  if (updates.type && ACTIONS_WITH_MAILBOX.has(updates.type) && !updated.value) {
    const first = targets[0];
    updated.value = first?.path ?? '';
    if (first) updated.mailboxId = first.id;
  }
  return updated;
}

/** Point a move/copy row at the folder with this id (from the folder picker). */
export function selectMailboxTarget(
  action: FilterAction,
  id: string,
  targets: MailboxTarget[],
): FilterAction {
  // Re-picking a folder that isn't listed (deleted, or not loaded) keeps it.
  if (id === mailboxIdFor(action, targets)) return action;
  const path = targets.find((t) => t.id === id)?.path ?? '';
  return updateFilterAction(action, { mailboxId: id || undefined, value: path }, targets);
}

/**
 * The action as saved: a move/copy stores the folder id next to the path,
 * and the path is refreshed from the id, so a renamed folder keeps
 * receiving the rule's mail.
 */
export function withMailboxTarget(action: FilterAction, targets: MailboxTarget[]): FilterAction {
  if (!ACTIONS_WITH_MAILBOX.has(action.type)) return action;
  const mailboxId = mailboxIdFor(action, targets);
  if (!mailboxId) return action;
  const path = targets.find((t) => t.id === mailboxId)?.path;
  return { ...action, mailboxId, value: path ?? action.value };
}
