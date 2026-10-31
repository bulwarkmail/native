type Translate = (key: string, fallback?: string, params?: Record<string, string | number>) => string;

/**
 * What a screen reader calls a folder or view row: its name, with the unread
 * count when there is unread mail ("Inbox, 3 unread"; webmail 7c282f1f4).
 * Without a label of its own a row reads its texts one by one, so the
 * Unified Inbox row came out as "All inboxes, /, 9".
 */
export function unreadRowLabel(name: string, unread: number, t: Translate): string {
  return unread > 0 ? t('shell.name_unread', '{name}, {count} unread', { name, count: unread }) : name;
}
