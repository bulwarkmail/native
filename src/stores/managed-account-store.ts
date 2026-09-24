import { create } from 'zustand';

// Ported from the webmail's stores/managed-account-store.ts. Tracks which
// account the settings screen is scoped to. `null` means the user's own
// account, the full settings list. When set to a shared/group account (picked
// under "Shared with me" in Account settings), Settings shows only the tabs
// that account supports behind a "Managing: <name>" banner, and the filters
// and vacation panes read `managedAccountId` to target it.
//
// Session-only navigation state (never persisted), so a shared-account scope
// can't leak into another account or a later launch.

export interface ManagedAccount {
  id: string;
  name: string;
}

interface ManagedAccountState {
  managedAccountId: string | null;
  managedAccount: ManagedAccount | null;
  /** Enter scoped mode for `account`, or pass `null` to return to the own account. */
  setManagedAccount: (account: ManagedAccount | null) => void;
  clear: () => void;
}

export const useManagedAccountStore = create<ManagedAccountState>((set) => ({
  managedAccountId: null,
  managedAccount: null,
  setManagedAccount: (account) =>
    set({ managedAccountId: account?.id ?? null, managedAccount: account }),
  clear: () => set({ managedAccountId: null, managedAccount: null }),
}));
