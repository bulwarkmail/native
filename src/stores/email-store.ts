import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Email, Mailbox } from '../api/types';
import {
  getMailboxes as fetchMailboxes,
  queryEmails,
  getEmails as fetchEmails,
  getFullEmail,
  setEmailKeywords,
  moveEmail,
  deleteEmail as apiDeleteEmail,
  searchEmails as apiSearchEmails,
} from '../api/email';
import { toWildcardQuery } from '../lib/search-utils';

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

export interface EmailState {
  mailboxes: Mailbox[];
  currentMailboxId: string | null;
  emails: Email[];
  totalEmails: number;
  loading: boolean;
  error: string | null;
  searchQuery: string;
  filters: EmailFilters;

  fetchMailboxes: () => Promise<void>;
  selectMailbox: (mailboxId: string) => Promise<void>;
  loadMoreEmails: () => Promise<void>;
  refreshEmails: () => Promise<void>;
  getEmailDetail: (id: string) => Promise<Email>;
  markRead: (emailId: string) => Promise<void>;
  markUnread: (emailId: string) => Promise<void>;
  toggleStar: (emailId: string, starred: boolean) => Promise<void>;
  moveToMailbox: (emailId: string, fromMailboxId: string, toMailboxId: string) => Promise<void>;
  deleteEmail: (emailId: string, trashMailboxId: string, currentMailboxId: string) => Promise<void>;
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
    // Reset search/filters when switching mailbox — matches webmail behavior.
    set({
      currentMailboxId: mailboxId,
      loading: true,
      error: null,
      emails: [],
      totalEmails: 0,
      searchQuery: '',
      filters: {},
    });
    try {
      const filter = buildJmapFilter(mailboxId, '', {});
      const { ids, total } = await queryEmails(mailboxId, { limit: 50, filter });
      const emails = ids.length > 0 ? await fetchEmails(ids) : [];
      set({ emails, totalEmails: total, loading: false });
    } catch (err) {
      console.warn('[email-store] selectMailbox failed:', err);
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load emails' });
    }
  },

  loadMoreEmails: async () => {
    const { currentMailboxId, emails, totalEmails, loading, searchQuery, filters } = get();
    if (!currentMailboxId || loading || emails.length >= totalEmails) return;

    set({ loading: true });
    try {
      const filter = buildJmapFilter(currentMailboxId, searchQuery, filters);
      const { ids } = await queryEmails(currentMailboxId, {
        position: emails.length,
        limit: 50,
        filter,
      });
      const newEmails = ids.length > 0 ? await fetchEmails(ids) : [];
      set({ emails: [...emails, ...newEmails], loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load more' });
    }
  },

  refreshEmails: async () => {
    const { currentMailboxId, searchQuery, filters } = get();
    if (!currentMailboxId) return;
    // Keep existing emails visible while refreshing — swap atomically once
    // the new list is ready so pull-to-refresh doesn't flash an empty list.
    set({ loading: true, error: null });
    try {
      const filter = buildJmapFilter(currentMailboxId, searchQuery, filters);
      const { ids, total } = await queryEmails(currentMailboxId, { limit: 50, filter });
      const emails = ids.length > 0 ? await fetchEmails(ids) : [];
      set({ emails, totalEmails: total, loading: false });
    } catch (err) {
      console.warn('[email-store] refreshEmails failed:', err);
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load emails' });
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
    return getFullEmail(id);
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

  moveToMailbox: async (emailId, fromMailboxId, toMailboxId) => {
    await moveEmail(emailId, fromMailboxId, toMailboxId);
    set({ emails: get().emails.filter((e) => e.id !== emailId) });
  },

  deleteEmail: async (emailId, trashMailboxId, currentMailboxId) => {
    await apiDeleteEmail(emailId, trashMailboxId, currentMailboxId);
    set({ emails: get().emails.filter((e) => e.id !== emailId) });
  },

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
