// Which icon a folder in the sidebar gets: one per special-use role (#288),
// else a plain folder. By role only, as the webmail does
// (components/layout/sidebar.tsx): a guess from the name gave a user folder
// "web/sentry" the Sent icon (native #80, webmail #1235), and a folder that
// holds no sent mail must not look like one that does.

export type MailboxIconKind =
  | 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'important' | 'flagged'
  | 'all' | 'memos' | 'scheduled' | 'snoozed' | 'shared' | 'folder' | 'folder-open';

const ROLE_ICONS: Record<string, MailboxIconKind> = {
  inbox: 'inbox',
  sent: 'sent',
  drafts: 'drafts',
  trash: 'trash',
  junk: 'junk',
  spam: 'junk',
  archive: 'archive',
  important: 'important',
  flagged: 'flagged',
  all: 'all',
  memos: 'memos',
  scheduled: 'scheduled',
  snoozed: 'snoozed',
  shared: 'shared',
};

export function mailboxIconKind(
  role: string | null | undefined,
  hasChildren: boolean,
  isExpanded: boolean,
): MailboxIconKind {
  const byRole = role ? ROLE_ICONS[role] : undefined;
  if (byRole) return byRole;
  return hasChildren && isExpanded ? 'folder-open' : 'folder';
}
