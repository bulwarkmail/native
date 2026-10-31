import { create } from 'zustand';

/** A `/files/<folder path>[?preview=<name>]` link (webmail FilesDeepLink). */
export interface FilesLink {
  /** Folder path in the drive, leading-slashed (`/` for the root). */
  path: string;
  /** File name to preview once the folder is open. */
  preview?: string;
  /**
   * A node of a drive shared with the user, by the id the Files tab lists it
   * under (`<owner>:<id>`): it has no path under the user's own root.
   */
  shared?: string;
}

// A files link arrives before the Files tab is mounted or has listed the
// drive. It is parked here and consumed by FilesScreen once it can walk the
// drive, like pending-mail-folder.
interface PendingFilesLinkState {
  link: FilesLink | null;
  set: (link: FilesLink | null) => void;
  consume: () => FilesLink | null;
}

export const usePendingFilesLink = create<PendingFilesLinkState>((set, get) => ({
  link: null,
  set: (link) => set({ link }),
  consume: () => {
    const link = get().link;
    if (link) set({ link: null });
    return link;
  },
}));

export function setPendingFilesLink(link: FilesLink | null): void {
  usePendingFilesLink.getState().set(link);
}
