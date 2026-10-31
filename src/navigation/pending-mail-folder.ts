import { create } from 'zustand';

// A `mail/folder/<ref>` deep link arrives before the mail list is mounted or
// its folders are loaded. The reference is parked here and consumed by
// EmailListScreen, which opens the folder once it can resolve it.
interface PendingMailFolderState {
  ref: string | null;
  set: (ref: string | null) => void;
  consume: () => string | null;
}

export const usePendingMailFolder = create<PendingMailFolderState>((set, get) => ({
  ref: null,
  set: (ref) => set({ ref }),
  consume: () => {
    const ref = get().ref;
    if (ref !== null) set({ ref: null });
    return ref;
  },
}));

export function setPendingMailFolder(ref: string | null): void {
  usePendingMailFolder.getState().set(ref);
}
