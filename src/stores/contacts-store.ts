import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ContactCard, AddressBook, StateChange } from '../api/types';
import {
  getAddressBooks as fetchAddressBooks,
  queryContacts,
  getContacts as fetchContacts,
  createContact as apiCreateContact,
  updateContact as apiUpdateContact,
  deleteContacts as apiDeleteContacts,
  createAddressBook as apiCreateAddressBook,
  updateAddressBook as apiUpdateAddressBook,
  deleteAddressBook as apiDeleteAddressBook,
  getContactsInBook,
} from '../api/contacts';
import { jmapClient } from '../api/jmap-client';
import {
  getContactDisplayName,
  getContactKeywords,
  isGroup,
  matchesContactSearch,
} from '../lib/contact-utils';

const SELECTED_CATEGORY_STORAGE_KEY = 'webmail:contacts:category:v1';

// Dedicated JMAP address book that backs the "trusted senders" allow-list.
// Mirrors the webmail so the same book is shared across clients.
export const TRUSTED_SENDERS_BOOK_NAME = 'Trusted Senders';

export type ContactCategory =
  | { type: 'all' }
  | { type: 'addressBook'; addressBookId: string }
  | { type: 'group'; groupId: string }
  | { type: 'keyword'; keyword: string }
  | { type: 'uncategorized' };

export interface ContactsState {
  addressBooks: AddressBook[];
  contacts: ContactCard[];
  selectedCategory: ContactCategory;
  loading: boolean;
  error: string | null;
  hydrated: boolean;

  // Trusted senders are stored as contacts in a dedicated JMAP address book so
  // the allow-list syncs across devices (matches the webmail behavior).
  trustedSendersBookId: string | null;
  trustedSenderEmails: string[];
  trustedSendersLoaded: boolean;
  trustedSendersLoading: boolean;

  hydrate: () => Promise<void>;
  fetchAddressBooks: () => Promise<void>;
  fetchContacts: (filter?: { text?: string; inAddressBook?: string }) => Promise<void>;
  refresh: () => Promise<void>;
  handleStateChange: (change: StateChange) => Promise<void>;

  createContact: (contact: Partial<ContactCard>, addressBookId: string) => Promise<ContactCard>;
  updateContact: (id: string, changes: Partial<ContactCard>) => Promise<void>;
  deleteContact: (id: string) => Promise<void>;
  bulkDelete: (ids: string[]) => Promise<void>;
  importContacts: (contacts: Partial<ContactCard>[], addressBookId: string) => Promise<number>;

  addContactKeyword: (id: string, keyword: string) => Promise<void>;
  removeContactKeyword: (id: string, keyword: string) => Promise<void>;
  addKeywordToContacts: (ids: string[], keyword: string) => Promise<void>;
  moveContactsToAddressBook: (ids: string[], addressBookId: string) => Promise<void>;

  // Address book management
  createAddressBook: (name: string) => Promise<AddressBook>;
  renameAddressBook: (id: string, name: string) => Promise<void>;
  deleteAddressBook: (id: string) => Promise<void>;

  // Trusted senders address book. Passive loads (createIfMissing=false) only
  // read an existing book; the book is created lazily on the first add.
  loadTrustedSendersBook: (createIfMissing?: boolean) => Promise<void>;
  addToTrustedSendersBook: (email: string) => Promise<void>;
  removeFromTrustedSendersBook: (email: string) => Promise<void>;
  isTrustedAddressBookSender: (email: string) => boolean;

  setSelectedCategory: (category: ContactCategory) => void;
  reset: () => void;
}

function persistCategory(category: ContactCategory): void {
  void AsyncStorage.setItem(SELECTED_CATEGORY_STORAGE_KEY, JSON.stringify(category)).catch(
    (err) => console.warn('[contacts-store] persist category failed', err),
  );
}

export const useContactsStore = create<ContactsState>()(
  persist(
    (set, get) => ({
  addressBooks: [],
  contacts: [],
  selectedCategory: { type: 'all' },
  loading: false,
  error: null,
  hydrated: false,

  trustedSendersBookId: null,
  trustedSenderEmails: [],
  trustedSendersLoaded: false,
  trustedSendersLoading: false,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(SELECTED_CATEGORY_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as ContactCategory;
        if (parsed && typeof parsed === 'object' && 'type' in parsed) {
          set({ selectedCategory: parsed });
        }
      }
    } catch (err) {
      console.warn('[contacts-store] hydrate failed', err);
    }
    set({ hydrated: true });
  },

  fetchAddressBooks: async () => {
    // No-op until a JMAP session exists. ContactsScreen fires this from a
    // mount-time useEffect, which on cold start runs before restoreSession
    // has set up the client.
    if (!jmapClient.isConnected) return;
    try {
      const addressBooks = (await fetchAddressBooks()) ?? [];
      set({ addressBooks });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load address books' });
    }
  },

  fetchContacts: async (filter) => {
    if (!jmapClient.isConnected) return;
    set({ loading: true, error: null });
    try {
      const ids = (await queryContacts(filter)) ?? [];
      const contacts = ids.length > 0 ? ((await fetchContacts(ids)) ?? []) : [];
      set({ contacts, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load contacts' });
    }
  },

  refresh: async () => {
    await get().fetchContacts();
  },

  handleStateChange: async (change) => {
    if (!jmapClient.isConnected) return;
    const accountId = jmapClient.accountId;
    const accountChanges = change.changed?.[accountId];
    if (!accountChanges) return;

    const addressBookChanged = 'AddressBook' in accountChanges;
    const contactChanged = 'ContactCard' in accountChanges || 'Contact' in accountChanges;
    if (!addressBookChanged && !contactChanged) return;

    if (addressBookChanged) {
      await get().fetchAddressBooks();
    }
    if (contactChanged) {
      await get().refresh();
    }
  },

  createContact: async (contact, addressBookId) => {
    const created = await apiCreateContact(contact, addressBookId);
    set({ contacts: [...get().contacts, created] });
    return created;
  },

  updateContact: async (id, changes) => {
    await apiUpdateContact(id, changes);
    set({
      contacts: get().contacts.map((c) =>
        c.id === id ? { ...c, ...changes } : c,
      ),
    });
  },

  deleteContact: async (id) => {
    await apiDeleteContacts([id]);
    set({ contacts: get().contacts.filter((c) => c.id !== id) });
  },

  bulkDelete: async (ids) => {
    if (ids.length === 0) return;
    await apiDeleteContacts(ids);
    const idSet = new Set(ids);
    set({ contacts: get().contacts.filter((c) => !idSet.has(c.id)) });
  },

  importContacts: async (incoming, addressBookId) => {
    let imported = 0;
    for (const contact of incoming) {
      try {
        // Strip the temporary client-side id; the server assigns a real one.
        const { id: _id, addressBookIds: _abIds, ...data } = contact;
        const created = await apiCreateContact(data, addressBookId);
        set({ contacts: [...get().contacts, created] });
        imported++;
      } catch (err) {
        console.warn('[contacts-store] import failed for one contact', err);
      }
    }
    return imported;
  },

  addContactKeyword: async (id, keyword) => {
    const kw = keyword.trim();
    if (!kw) return;
    const contact = get().contacts.find((c) => c.id === id);
    if (!contact) return;
    const keywords = { ...(contact.keywords || {}), [kw]: true };
    await get().updateContact(id, { keywords });
  },

  removeContactKeyword: async (id, keyword) => {
    const contact = get().contacts.find((c) => c.id === id);
    if (!contact?.keywords) return;
    const { [keyword]: _removed, ...rest } = contact.keywords;
    await get().updateContact(id, { keywords: rest });
  },

  addKeywordToContacts: async (ids, keyword) => {
    const kw = keyword.trim();
    if (!kw) return;
    for (const id of ids) {
      await get().addContactKeyword(id, kw);
    }
  },

  moveContactsToAddressBook: async (ids, addressBookId) => {
    for (const id of ids) {
      await get().updateContact(id, { addressBookIds: { [addressBookId]: true } });
    }
  },

  createAddressBook: async (name) => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Address book name is required');
    const book = await apiCreateAddressBook(trimmed);
    set({ addressBooks: [...get().addressBooks, book] });
    return book;
  },

  renameAddressBook: async (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await apiUpdateAddressBook(id, { name: trimmed });
    set({
      addressBooks: get().addressBooks.map((b) => (b.id === id ? { ...b, name: trimmed } : b)),
    });
  },

  deleteAddressBook: async (id) => {
    await apiDeleteAddressBook(id);
    set({
      addressBooks: get().addressBooks.filter((b) => b.id !== id),
      // Drop the deleted book id from any cached contact so the UI doesn't
      // keep filtering against a book that no longer exists.
      contacts: get().contacts.map((c) => {
        if (!c.addressBookIds?.[id]) return c;
        const { [id]: _gone, ...rest } = c.addressBookIds;
        return { ...c, addressBookIds: rest };
      }),
    });
    const category = get().selectedCategory;
    if (category.type === 'addressBook' && category.addressBookId === id) {
      get().setSelectedCategory({ type: 'all' });
    }
  },

  loadTrustedSendersBook: async (createIfMissing = false) => {
    if (!jmapClient.isConnected || get().trustedSendersLoading) return;
    set({ trustedSendersLoading: true });
    try {
      const books = (await fetchAddressBooks()) ?? [];
      let book = books.find((b) => b.name === TRUSTED_SENDERS_BOOK_NAME);
      if (!book) {
        if (!createIfMissing) {
          set({ trustedSendersLoaded: true, trustedSendersLoading: false });
          return;
        }
        book = await apiCreateAddressBook(TRUSTED_SENDERS_BOOK_NAME);
      }
      const bookId = book.id;
      const cards = await getContactsInBook(bookId);
      const emails = cards.flatMap((c) =>
        c.emails ? Object.values(c.emails).map((e) => e.address.toLowerCase().trim()) : [],
      ).filter(Boolean);
      set({
        trustedSendersBookId: bookId,
        trustedSenderEmails: emails,
        trustedSendersLoaded: true,
        trustedSendersLoading: false,
      });
    } catch (err) {
      console.warn('[contacts-store] load trusted senders failed', err);
      set({ trustedSendersLoaded: true, trustedSendersLoading: false });
    }
  },

  addToTrustedSendersBook: async (email) => {
    const normalized = email.toLowerCase().trim();
    if (!normalized || get().trustedSenderEmails.includes(normalized)) return;

    let bookId = get().trustedSendersBookId;
    if (!bookId) {
      await get().loadTrustedSendersBook(true);
      bookId = get().trustedSendersBookId;
    }
    if (!bookId) throw new Error('Could not find or create the trusted senders address book');

    await apiCreateContact({ emails: { email: { address: normalized } } }, bookId);
    set({ trustedSenderEmails: [...get().trustedSenderEmails, normalized] });
  },

  removeFromTrustedSendersBook: async (email) => {
    const normalized = email.toLowerCase().trim();
    const bookId = get().trustedSendersBookId;
    if (!bookId) return;
    const cards = await getContactsInBook(bookId);
    const match = cards.find((c) =>
      c.emails && Object.values(c.emails).some((e) => e.address.toLowerCase().trim() === normalized),
    );
    if (match) await apiDeleteContacts([match.id]);
    set({ trustedSenderEmails: get().trustedSenderEmails.filter((e) => e !== normalized) });
  },

  isTrustedAddressBookSender: (email) =>
    get().trustedSenderEmails.includes(email.toLowerCase().trim()),

  setSelectedCategory: (category) => {
    set({ selectedCategory: category });
    persistCategory(category);
  },

  reset: () => set({
    addressBooks: [],
    contacts: [],
    selectedCategory: { type: 'all' },
    loading: false,
    error: null,
    trustedSendersBookId: null,
    trustedSenderEmails: [],
    trustedSendersLoaded: false,
    trustedSendersLoading: false,
  }),
    }),
    {
      // Persist address books and contact cards so the list renders instantly
      // on re-open. A refresh runs in the background once the JMAP session is
      // ready and replaces the cached data.
      name: 'contacts-cache',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        addressBooks: state.addressBooks,
        contacts: state.contacts,
      }),
    },
  ),
);

// ─── Selectors ───────────────────────────────────────────

export function selectIndividuals(state: ContactsState): ContactCard[] {
  return state.contacts.filter((c) => !isGroup(c));
}

export function selectGroups(state: ContactsState): ContactCard[] {
  return state.contacts.filter(isGroup);
}

export function selectKeywordsUsed(state: ContactsState): Array<{ keyword: string; count: number }> {
  const counts = new Map<string, number>();
  for (const contact of state.contacts) {
    for (const kw of getContactKeywords(contact)) {
      counts.set(kw, (counts.get(kw) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([keyword, count]) => ({ keyword, count }))
    .sort((a, b) => a.keyword.localeCompare(b.keyword));
}

export function selectAddressBooksWithCount(state: ContactsState): Array<AddressBook & { count: number }> {
  return state.addressBooks.map((book) => ({
    ...book,
    count: state.contacts.filter((c) => !isGroup(c) && c.addressBookIds?.[book.id]).length,
  }));
}

export function selectGroupMembers(state: ContactsState, groupId: string): ContactCard[] {
  const group = state.contacts.find((c) => c.id === groupId);
  if (!group?.members) return [];
  const memberKeys = Object.keys(group.members).filter((k) => group.members![k]);
  const normalized = memberKeys.map((k) => (k.startsWith('urn:uuid:') ? k.slice(9) : k));
  const keySet = new Set([...memberKeys, ...normalized]);
  return state.contacts.filter((c) => {
    if (keySet.has(c.id)) return true;
    if (c.uid) {
      const bareUid = c.uid.startsWith('urn:uuid:') ? c.uid.slice(9) : c.uid;
      if (keySet.has(c.uid) || keySet.has(bareUid)) return true;
    }
    return false;
  });
}

export function selectVisibleContacts(
  state: ContactsState,
  query: string,
): ContactCard[] {
  const individuals = selectIndividuals(state);
  const category = state.selectedCategory;

  let filtered: ContactCard[];
  switch (category.type) {
    case 'all':
      filtered = individuals;
      break;
    case 'addressBook':
      filtered = individuals.filter((c) => c.addressBookIds?.[category.addressBookId]);
      break;
    case 'group': {
      filtered = selectGroupMembers(state, category.groupId).filter((c) => !isGroup(c));
      break;
    }
    case 'keyword':
      filtered = individuals.filter((c) => c.keywords?.[category.keyword]);
      break;
    case 'uncategorized':
      filtered = individuals.filter((c) => !c.addressBookIds || Object.keys(c.addressBookIds).length === 0);
      break;
    default:
      filtered = individuals;
  }

  if (!query) return filtered;
  return filtered.filter((c) => matchesContactSearch(c, query));
}

export function sortContactsByDisplayName(contacts: ContactCard[]): ContactCard[] {
  return [...contacts].sort((a, b) =>
    getContactDisplayName(a).localeCompare(getContactDisplayName(b), undefined, { sensitivity: 'base' }),
  );
}
