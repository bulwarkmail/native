import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ContactCard, AddressBook, StateChange } from '../api/types';
import {
  getAddressBooks as fetchAddressBooks,
  queryContacts,
  getContacts as fetchContacts,
  createContact as apiCreateContact,
  updateContact as apiUpdateContact,
  deleteContacts as apiDeleteContacts,
} from '../api/contacts';
import { jmapClient } from '../api/jmap-client';
import {
  getContactDisplayName,
  getContactKeywords,
  isGroup,
  matchesContactSearch,
} from '../lib/contact-utils';

const SELECTED_CATEGORY_STORAGE_KEY = 'webmail:contacts:category:v1';

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

  hydrate: () => Promise<void>;
  fetchAddressBooks: () => Promise<void>;
  fetchContacts: (filter?: { text?: string; inAddressBook?: string }) => Promise<void>;
  refresh: () => Promise<void>;
  handleStateChange: (change: StateChange) => Promise<void>;

  createContact: (contact: Partial<ContactCard>, addressBookId: string) => Promise<ContactCard>;
  updateContact: (id: string, changes: Partial<ContactCard>) => Promise<void>;
  deleteContact: (id: string) => Promise<void>;
  bulkDelete: (ids: string[]) => Promise<void>;

  addContactKeyword: (id: string, keyword: string) => Promise<void>;
  removeContactKeyword: (id: string, keyword: string) => Promise<void>;
  moveContactsToAddressBook: (ids: string[], addressBookId: string) => Promise<void>;

  setSelectedCategory: (category: ContactCategory) => void;
  reset: () => void;
}

function persistCategory(category: ContactCategory): void {
  void AsyncStorage.setItem(SELECTED_CATEGORY_STORAGE_KEY, JSON.stringify(category)).catch(
    (err) => console.warn('[contacts-store] persist category failed', err),
  );
}

export const useContactsStore = create<ContactsState>((set, get) => ({
  addressBooks: [],
  contacts: [],
  selectedCategory: { type: 'all' },
  loading: false,
  error: null,
  hydrated: false,

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
    try {
      const addressBooks = (await fetchAddressBooks()) ?? [];
      set({ addressBooks });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load address books' });
    }
  },

  fetchContacts: async (filter) => {
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

  moveContactsToAddressBook: async (ids, addressBookId) => {
    for (const id of ids) {
      await get().updateContact(id, { addressBookIds: { [addressBookId]: true } });
    }
  },

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
  }),
}));

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
