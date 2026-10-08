// The icons a folder can be given in Settings → Folders: webmail's 18 lucide
// names, in its order (components/settings/folder-settings.tsx ICON_CHOICES).
// Kept free of lucide so the store and its tests do not load the icon set;
// components/folder-icon.tsx maps a name to its component.

export const FOLDER_ICON_NAMES = [
  'Folder', 'Star', 'Heart', 'Bookmark', 'Tag', 'Flag', 'Briefcase', 'Users', 'Bell',
  'Zap', 'Globe', 'Lock', 'Eye', 'MessageSquare', 'Mail', 'Inbox', 'Archive', 'FileText',
] as const;

export type FolderIconName = (typeof FOLDER_ICON_NAMES)[number];

const NAMES: ReadonlySet<string> = new Set(FOLDER_ICON_NAMES);

/** True for one of the 18 offered names; anything else (a stale or hand-edited value) is not an icon. */
export function isFolderIconName(v: unknown): v is FolderIconName {
  return typeof v === 'string' && NAMES.has(v);
}
