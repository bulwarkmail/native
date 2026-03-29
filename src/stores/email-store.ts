import { create } from 'zustand';
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

export interface EmailState {
  mailboxes: Mailbox[];
  currentMailboxId: string | null;
  emails: Email[];
  totalEmails: number;
  loading: boolean;
  error: string | null;

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
  reset: () => void;
}

export const useEmailStore = create<EmailState>((set, get) => ({
  mailboxes: [],
  currentMailboxId: null,
  emails: [],
  totalEmails: 0,
  loading: false,
  error: null,

  fetchMailboxes: async () => {
    try {
      const mailboxes = await fetchMailboxes();
      set({ mailboxes });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load mailboxes' });
    }
  },

  selectMailbox: async (mailboxId) => {
    set({ currentMailboxId: mailboxId, loading: true, error: null, emails: [], totalEmails: 0 });
    try {
      const { ids, total } = await queryEmails(mailboxId, { limit: 50 });
      const emails = ids.length > 0 ? await fetchEmails(ids) : [];
      set({ emails, totalEmails: total, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load emails' });
    }
  },

  loadMoreEmails: async () => {
    const { currentMailboxId, emails, totalEmails, loading } = get();
    if (!currentMailboxId || loading || emails.length >= totalEmails) return;

    set({ loading: true });
    try {
      const { ids } = await queryEmails(currentMailboxId, {
        position: emails.length,
        limit: 50,
      });
      const newEmails = ids.length > 0 ? await fetchEmails(ids) : [];
      set({ emails: [...emails, ...newEmails], loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load more' });
    }
  },

  refreshEmails: async () => {
    const { currentMailboxId } = get();
    if (currentMailboxId) {
      await get().selectMailbox(currentMailboxId);
    }
  },

  getEmailDetail: async (id) => {
    return getFullEmail(id);
  },

  markRead: async (emailId) => {
    await setEmailKeywords(emailId, { $seen: true });
    set({
      emails: get().emails.map((e) =>
        e.id === emailId ? { ...e, keywords: { ...e.keywords, $seen: true } } : e,
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
  }),
}));
