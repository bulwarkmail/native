// Which actions of the drawer's folder sheet can run now (webmail
// components/layout/mailbox-context-menu.tsx, f92b7d942): Mark as read
// greys out with nothing unread, and every action that needs the server
// greys out while offline, under an "offline" note. Muting notifications is
// a setting of the device and stays.

export interface GatedAction {
  key: string;
  disabled?: boolean;
}

interface CountedMailbox {
  id: string;
  parentId?: string | null;
  unreadEmails?: number;
}

/** Unread messages in a folder and the folders under it; undefined where a count isn't known. */
export function unreadInTree(mailbox: CountedMailbox, mailboxes: readonly CountedMailbox[]): number | undefined {
  let total = 0;
  const seen = new Set<string>();
  const visit = (box: CountedMailbox): boolean => {
    if (seen.has(box.id)) return true;
    seen.add(box.id);
    if (typeof box.unreadEmails !== 'number') return false;
    total += box.unreadEmails;
    return mailboxes.filter((child) => child.parentId === box.id).every(visit);
  };
  return visit(mailbox) ? total : undefined;
}

const LOCAL_ACTIONS = new Set(['mute']);

/**
 * `actions` with `disabled` set: `read` without unread mail in the folder,
 * `tree` and `all` without any in what they cover, and everything but the
 * local actions while offline.
 */
export function gateFolderActions<T extends GatedAction>(
  actions: T[],
  state: { offline: boolean; unreadHere?: number; unreadBelow?: number; unreadAll?: number },
): T[] {
  return actions.map((action) => {
    const nothingToRead =
      (action.key === 'read' && state.unreadHere === 0)
      || (action.key === 'tree' && state.unreadBelow === 0)
      || (action.key === 'all' && state.unreadAll === 0);
    const needsServer = state.offline && !LOCAL_ACTIONS.has(action.key);
    return nothingToRead || needsServer ? { ...action, disabled: true } : action;
  });
}
