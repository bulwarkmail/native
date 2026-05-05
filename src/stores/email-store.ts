import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Email, Mailbox, StateChange } from '../api/types';
import { jmapClient } from '../api/jmap-client';
import {
  getMailboxes as fetchMailboxes,
  queryEmails,
  getEmails as fetchEmails,
  getFullEmail,
  setEmailKeywords,
  moveEmail,
  archiveEmails as apiArchiveEmails,
  deleteEmail as apiDeleteEmail,
  restoreEmailMailboxes,
  searchEmails as apiSearchEmails,
} from '../api/email';
import { toWildcardQuery } from '../lib/search-utils';
import { useSettingsStore } from './settings-store';
import { useOfflineCacheStore } from './offline-cache-store';

export interface EmailFilters {
  from?: string;
  to?: string;
  subject?: string;
  dateAfter?: string;  // YYYY-MM-DD
  dateBefore?: string; // YYYY-MM-DD
  hasAttachment?: boolean; // undefined = unset, true = with, false = without
  isStarred?: boolean;
  isUnread?: boolean;
}

// Snapshot of an action that can still be reversed via the undo snackbar.
// We store the full email object so undo can re-insert it into the visible list
// optimistically without waiting for a refetch.
export interface UndoEntry {
  kind: 'archive' | 'delete' | 'move' | 'spam';
  /** Human-readable label shown in the snackbar (e.g. "Email archived"). */
  label: string;
  /** Time the entry was created - the snackbar uses this to drive its timer. */
  createdAt: number;
  /** Each item is one email's pre-action mailboxIds, used to restore it. */
  items: Array<{ email: Email; originalMailboxIds: Record<string, boolean> }>;
}

export interface EmailState {
  mailboxes: Mailbox[];
  currentMailboxId: string | null;
  emails: Email[];
  totalEmails: number;
  loading: boolean;
  error: string | null;
  searchQuery: string;
  filters: EmailFilters;
  pendingUndo: UndoEntry | null;

  fetchMailboxes: () => Promise<void>;
  selectMailbox: (mailboxId: string) => Promise<void>;
  loadMoreEmails: () => Promise<void>;
  refreshEmails: () => Promise<void>;
  handleStateChange: (change: StateChange) => Promise<void>;
  getEmailDetail: (id: string) => Promise<Email>;
  markRead: (emailId: string) => Promise<void>;
  markUnread: (emailId: string) => Promise<void>;
  toggleStar: (emailId: string, starred: boolean) => Promise<void>;
  togglePin: (emailId: string, pinned: boolean) => Promise<void>;
  moveToMailbox: (emailId: string, fromMailboxId: string, toMailboxId: string) => Promise<void>;
  archiveEmail: (emailId: string) => Promise<void>;
  deleteEmail: (emailId: string, trashMailboxId: string, currentMailboxId: string) => Promise<void>;
  undoLast: () => Promise<void>;
  clearUndo: () => void;
  searchEmails: (query: string) => Promise<Email[]>;
  setSearchQuery: (query: string) => void;
  setFilters: (filters: EmailFilters) => void;
  clearSearchAndFilters: () => void;
  reset: () => void;
}

function buildJmapFilter(
  mailboxId: string,
  searchQuery: string,
  filters: EmailFilters,
): Record<string, unknown> {
  const conditions: Record<string, unknown>[] = [{ inMailbox: mailboxId }];

  const trimmed = searchQuery.trim();
  if (trimmed) conditions.push({ text: toWildcardQuery(trimmed) });

  if (filters.from) conditions.push({ from: filters.from });
  if (filters.to) conditions.push({ to: filters.to });
  if (filters.subject) conditions.push({ subject: filters.subject });

  if (filters.dateAfter) {
    const d = new Date(filters.dateAfter);
    if (!isNaN(d.getTime())) conditions.push({ after: d.toISOString() });
  }
  if (filters.dateBefore) {
    const d = new Date(filters.dateBefore);
    if (!isNaN(d.getTime())) {
      d.setHours(23, 59, 59, 999);
      conditions.push({ before: d.toISOString() });
    }
  }

  if (filters.hasAttachment === true) conditions.push({ hasAttachment: true });
  else if (filters.hasAttachment === false) conditions.push({ hasAttachment: false });

  if (filters.isUnread === true) conditions.push({ notKeyword: '$seen' });
  else if (filters.isUnread === false) conditions.push({ hasKeyword: '$seen' });

  if (filters.isStarred === true) conditions.push({ hasKeyword: '$flagged' });
  else if (filters.isStarred === false) conditions.push({ notKeyword: '$flagged' });

  if (conditions.length === 1) return conditions[0];
  return { operator: 'AND', conditions };
}

export const useEmailStore = create<EmailState>()(
  persist(
    (set, get) => ({
  mailboxes: [],
  currentMailboxId: null,
  emails: [],
  totalEmails: 0,
  loading: false,
  error: null,
  searchQuery: '',
  filters: {},
  pendingUndo: null,

  fetchMailboxes: async () => {
    try {
      const mailboxes = await fetchMailboxes();
      set({ mailboxes });
    } catch (err) {
      console.warn('[email-store] fetchMailboxes failed:', err);
      set({ error: err instanceof Error ? err.message : 'Failed to load mailboxes' });
    }
  },

  selectMailbox: async (mailboxId) => {
    // Reset search/filters when switching mailbox - matches webmail behavior.
    // Switching mailboxes invalidates any pending undo: the snackbar would be
    // stale and the restored email would re-appear in a different view.
    set({
      currentMailboxId: mailboxId,
      loading: true,
      error: null,
      emails: [],
      totalEmails: 0,
      searchQuery: '',
      filters: {},
      pendingUndo: null,
    });

    // Seed from the offline cache immediately so changing folders shows
    // something even before the network responds — and is the fallback
    // when offline. The network result will replace this once it arrives.
    const cacheStore = useOfflineCacheStore.getState();
    if (!cacheStore.hydrated) await cacheStore.hydrate();
    const limit = useSettingsStore.getState().emailsPerPage;
    let cached: Email[] = [];
    if (cacheStore.totalCount() > 0) {
      try {
        cached = await cacheStore.getEmailsInMailbox(mailboxId, Math.max(limit, 50));
        if (cached.length > 0 && get().currentMailboxId === mailboxId) {
          set({ emails: cached, totalEmails: cached.length });
        }
      } catch (err) {
        console.warn('[email-store] cache seed failed:', err);
      }
    }

    try {
      const filter = buildJmapFilter(mailboxId, '', {});
      const { ids, total } = await queryEmails(mailboxId, { limit, filter });
      const emails = ids.length > 0 ? await fetchEmails(ids) : [];
      // Race guard: don't overwrite if the user already moved to a different
      // mailbox while this request was in flight.
      if (get().currentMailboxId !== mailboxId) return;
      set({ emails, totalEmails: total, loading: false });
    } catch (err) {
      console.warn('[email-store] selectMailbox failed:', err);
      if (get().currentMailboxId !== mailboxId) return;
      // Keep whatever the cache seeded with; only surface the error when the
      // cache is empty. With cached emails visible the OfflineBanner already
      // tells the user the data is stale.
      set({
        loading: false,
        error: cached.length > 0 ? null : (err instanceof Error ? err.message : 'Failed to load emails'),
      });
    }
  },

  loadMoreEmails: async () => {
    const { currentMailboxId, emails, totalEmails, loading, searchQuery, filters } = get();
    if (!currentMailboxId || loading || emails.length >= totalEmails) return;

    set({ loading: true });
    try {
      const filter = buildJmapFilter(currentMailboxId, searchQuery, filters);
      const limit = useSettingsStore.getState().emailsPerPage;
      const { ids } = await queryEmails(currentMailboxId, {
        position: emails.length,
        limit,
        filter,
      });
      const newEmails = ids.length > 0 ? await fetchEmails(ids) : [];
      set({ emails: [...emails, ...newEmails], loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load more' });
    }
  },

  refreshEmails: async () => {
    const { currentMailboxId, searchQuery, filters, emails: existing } = get();
    if (!currentMailboxId) return;
    // Keep existing emails visible while refreshing - swap atomically once
    // the new list is ready so pull-to-refresh doesn't flash an empty list.
    set({ loading: true, error: null });
    try {
      const filter = buildJmapFilter(currentMailboxId, searchQuery, filters);
      const limit = useSettingsStore.getState().emailsPerPage;
      const { ids, total } = await queryEmails(currentMailboxId, { limit, filter });
      const emails = ids.length > 0 ? await fetchEmails(ids) : [];
      set({ emails, totalEmails: total, loading: false });
    } catch (err) {
      console.warn('[email-store] refreshEmails failed:', err);
      // If the list was empty before the refresh attempt, fall back to the
      // offline cache so the user still sees something. Otherwise keep what
      // they had visible and let the OfflineBanner explain.
      if (existing.length === 0) {
        try {
          const cacheStore = useOfflineCacheStore.getState();
          if (!cacheStore.hydrated) await cacheStore.hydrate();
          if (cacheStore.totalCount() > 0) {
            const limit = useSettingsStore.getState().emailsPerPage;
            const cached = await cacheStore.getEmailsInMailbox(
              currentMailboxId,
              Math.max(limit, 50),
            );
            if (get().currentMailboxId === currentMailboxId && cached.length > 0) {
              set({ emails: cached, totalEmails: cached.length, loading: false, error: null });
              return;
            }
          }
        } catch (cacheErr) {
          console.warn('[email-store] refresh cache fallback failed:', cacheErr);
        }
      }
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load emails' });
    }
  },

  handleStateChange: async (change) => {
    if (!jmapClient.currentSession) return;
    const accountId = jmapClient.accountId;
    const accountChanges = change.changed?.[accountId];
    if (!accountChanges) return;

    const mailboxChanged = 'Mailbox' in accountChanges;
    const emailChanged = 'Email' in accountChanges || 'EmailDelivery' in accountChanges;
    if (!mailboxChanged && !emailChanged) return;

    if (mailboxChanged) {
      await get().fetchMailboxes();
    }
    if (emailChanged && get().currentMailboxId) {
      await get().refreshEmails();
    }
  },

  setSearchQuery: (query) => {
    set({ searchQuery: query });
    void get().refreshEmails();
  },

  setFilters: (filters) => {
    set({ filters });
    void get().refreshEmails();
  },

  clearSearchAndFilters: () => {
    const { searchQuery, filters } = get();
    if (!searchQuery && Object.keys(filters).length === 0) return;
    set({ searchQuery: '', filters: {} });
    void get().refreshEmails();
  },

  getEmailDetail: async (id) => {
    // Try the network first so the user sees fresh keywords/flags. If that
    // fails (offline / server unreachable), fall back to the offline cache
    // when the message is in it. Without the cache hit, propagate the error
    // so the caller can surface it.
    try {
      const fresh = await getFullEmail(id);
      // Opportunistically refresh the cached copy so the next offline open
      // reflects the latest keywords without needing a full sync.
      const cache = useOfflineCacheStore.getState();
      if (cache.has(id)) {
        try {
          const size = JSON.stringify(fresh).length;
          await cache.put(fresh, size);
        } catch { /* ignore — best-effort refresh */ }
      }
      return fresh;
    } catch (err) {
      const cached = await useOfflineCacheStore.getState().get(id);
      if (cached) return cached;
      throw err;
    }
  },

  markRead: async (emailId) => {
    const email = get().emails.find((e) => e.id === emailId);
    const nextKeywords = { ...(email?.keywords ?? {}), $seen: true };
    await setEmailKeywords(emailId, nextKeywords);
    set({
      emails: get().emails.map((e) =>
        e.id === emailId ? { ...e, keywords: nextKeywords } : e,
      ),
    });
  },

  markUnread: async (emailId) => {
    const email = get().emails.find((e) => e.id === emailId);
    if (!email) return;
    const { $seen, ...rest } = email.keywords;
    await setEmailKeywords(emailId, rest);
    set({
      emails: get().emails.map((e) =>
        e.id === emailId ? { ...e, keywords: rest } : e,
      ),
    });
  },

  toggleStar: async (emailId, starred) => {
    const email = get().emails.find((e) => e.id === emailId);
    if (!email) return;
    const keywords = { ...email.keywords };
    if (starred) {
      keywords.$flagged = true;
    } else {
      delete keywords.$flagged;
    }
    await setEmailKeywords(emailId, keywords);
    set({
      emails: get().emails.map((e) =>
        e.id === emailId ? { ...e, keywords } : e,
      ),
    });
  },

  togglePin: async (emailId, pinned) => {
    const email = get().emails.find((e) => e.id === emailId);
    if (!email) return;
    const keywords = { ...email.keywords };
    if (pinned) {
      keywords.$important = true;
    } else {
      delete keywords.$important;
    }
    await setEmailKeywords(emailId, keywords);
    set({
      emails: get().emails.map((e) =>
        e.id === emailId ? { ...e, keywords } : e,
      ),
    });
  },

  moveToMailbox: async (emailId, fromMailboxId, toMailboxId) => {
    const email = get().emails.find((e) => e.id === emailId);
    const original = email ? { ...email.mailboxIds } : null;

    await moveEmail(emailId, fromMailboxId, toMailboxId);
    set({ emails: get().emails.filter((e) => e.id !== emailId) });

    if (email && original) {
      const targetName = get().mailboxes.find((m) => m.id === toMailboxId)?.name;
      set({
        pendingUndo: {
          kind: 'move',
          label: targetName ? `Email moved to ${targetName}` : 'Email moved',
          createdAt: Date.now(),
          items: [{ email, originalMailboxIds: original }],
        },
      });
    }
  },

  archiveEmail: async (emailId) => {
    const { emails, mailboxes } = get();
    const email = emails.find((e) => e.id === emailId);
    if (!email) return;

    const archiveMailbox = mailboxes.find(
      (m) => m.role === 'archive' || m.name.toLowerCase() === 'archive',
    );
    if (!archiveMailbox) return;
    if (email.mailboxIds?.[archiveMailbox.id]) return;

    const mode = useSettingsStore.getState().archiveMode;
    const original = { ...email.mailboxIds };

    await apiArchiveEmails(
      [{ id: email.id, receivedAt: email.receivedAt }],
      archiveMailbox.id,
      mode,
      mailboxes,
    );

    set({
      emails: get().emails.filter((e) => e.id !== emailId),
      pendingUndo: {
        kind: 'archive',
        label: 'Email archived',
        createdAt: Date.now(),
        items: [{ email, originalMailboxIds: original }],
      },
    });

    // Auto-sort modes may have created new year/month folders - refresh the
    // mailbox list so the sidebar picks them up on the next render.
    if (mode !== 'single') {
      void get().fetchMailboxes();
    }
  },

  deleteEmail: async (emailId, trashMailboxId, currentMailboxId) => {
    const email = get().emails.find((e) => e.id === emailId);
    const original = email ? { ...email.mailboxIds } : null;
    const settings = useSettingsStore.getState();
    const { mailboxes } = get();
    const junkMailbox = mailboxes.find((m) => m.role === 'junk' || m.role === 'spam');
    const inJunk = !!(junkMailbox && email?.mailboxIds?.[junkMailbox.id]);
    const inTrash = currentMailboxId === trashMailboxId;

    // Resolve effective destination:
    // - already in trash → must destroy (no further folder to move to)
    // - in junk and the user opted to skip the trash for junk → destroy
    // - the user set 'permanent' as the global default → destroy
    // - otherwise → move to trash and offer undo
    const destroy =
      inTrash ||
      settings.deleteAction === 'permanent' ||
      (settings.permanentlyDeleteJunk && inJunk);

    if (destroy) {
      // Use the trash mailbox as the "current" so apiDeleteEmail takes the
      // destroy branch even when the source folder isn't trash.
      await apiDeleteEmail(emailId, trashMailboxId, trashMailboxId);
    } else {
      await apiDeleteEmail(emailId, trashMailboxId, currentMailboxId);
    }
    set({ emails: get().emails.filter((e) => e.id !== emailId) });

    // Permanent destroy can't be undone - skip the snackbar so we don't
    // promise an undo we can't deliver.
    if (email && original && !destroy) {
      set({
        pendingUndo: {
          kind: 'delete',
          label: 'Email moved to Trash',
          createdAt: Date.now(),
          items: [{ email, originalMailboxIds: original }],
        },
      });
    }
  },

  undoLast: async () => {
    const entry = get().pendingUndo;
    if (!entry) return;
    set({ pendingUndo: null });

    try {
      await restoreEmailMailboxes(
        entry.items.map((it) => ({ id: it.email.id, mailboxIds: it.originalMailboxIds })),
      );
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Undo failed' });
      return;
    }

    // Re-insert each restored email into the visible list if its original
    // mailboxIds include the current view. Server is the source of truth for
    // ordering, but local re-insertion gives the user instant feedback.
    const { currentMailboxId, emails } = get();
    if (currentMailboxId) {
      const restored = entry.items
        .filter((it) => it.originalMailboxIds[currentMailboxId])
        .map((it) => ({ ...it.email, mailboxIds: it.originalMailboxIds }));
      if (restored.length > 0) {
        const merged = [...restored, ...emails].sort(
          (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime(),
        );
        set({ emails: merged });
      }
    }
  },

  clearUndo: () => set({ pendingUndo: null }),

  searchEmails: async (query) => {
    const ids = await apiSearchEmails(query);
    if (ids.length === 0) return [];
    return fetchEmails(ids);
  },

  reset: () => set({
    mailboxes: [],
    currentMailboxId: null,
    emails: [],
    totalEmails: 0,
    loading: false,
    error: null,
    searchQuery: '',
    filters: {},
  }),
    }),
    {
      // Persist the mail list so the UI can render instantly on re-open,
      // before the JMAP session has finished restoring. auth-store triggers
      // a background refresh once the session is ready.
      name: 'email-cache',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        mailboxes: state.mailboxes,
        currentMailboxId: state.currentMailboxId,
        emails: state.emails,
        totalEmails: state.totalEmails,
      }),
    },
  ),
);
