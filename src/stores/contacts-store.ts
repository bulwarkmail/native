import { create } from 'zustand';
import type { ContactCard, AddressBook } from '../api/types';
import {
  getAddressBooks as fetchAddressBooks,
  queryContacts,
  getContacts as fetchContacts,
  createContact as apiCreateContact,
  updateContact as apiUpdateContact,
  deleteContacts as apiDeleteContacts,
} from '../api/contacts';

export interface ContactsState {
  addressBooks: AddressBook[];
  contacts: ContactCard[];
  loading: boolean;
  error: string | null;

  fetchAddressBooks: () => Promise<void>;
  fetchContacts: (filter?: { text?: string; inAddressBook?: string }) => Promise<void>;
  createContact: (contact: Partial<ContactCard>, addressBookId: string) => Promise<ContactCard>;
  updateContact: (id: string, changes: Partial<ContactCard>) => Promise<void>;
  deleteContact: (id: string) => Promise<void>;
  reset: () => void;
}

export const useContactsStore = create<ContactsState>((set, get) => ({
  addressBooks: [],
  contacts: [],
  loading: false,
  error: null,

  fetchAddressBooks: async () => {
    try {
      const addressBooks = await fetchAddressBooks();
      set({ addressBooks });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load address books' });
    }
  },

  fetchContacts: async (filter) => {
    set({ loading: true, error: null });
    try {
      const ids = await queryContacts(filter);
      const contacts = ids.length > 0 ? await fetchContacts(ids) : [];
      set({ contacts, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load contacts' });
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

  reset: () => set({
    addressBooks: [],
    contacts: [],
    loading: false,
    error: null,
  }),
}));
