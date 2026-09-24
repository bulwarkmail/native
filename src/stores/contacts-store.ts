import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createPersistStorage, memoizeSlice } from './persist-storage';
import type { ContactCard, AddressBook, StateChange, EmailAddress } from '../api/types';
import {
  getAddressBooks as fetchPrimaryAddressBooks,
  getAllAddressBooks as fetchAllAddressBooks,
  queryContacts,
  getContacts as fetchContactsByIds,
  getAllContacts as fetchAllContacts,
  createContact as apiCreateContact,
  updateContact as apiUpdateContact,
  deleteContacts as apiDeleteContacts,
  createAddressBook as apiCreateAddressBook,
  updateAddressBook as apiUpdateAddressBook,
  deleteAddressBook as apiDeleteAddressBook,
  setDefaultAddressBook as apiSetDefaultAddressBook,
  getContactsInBook,
  getContactsAccountId,
  getContactCapableAccountIds,
  namespaceId,
  stripClientFields,
} from '../api/contacts';
import { queryRecentRecipients, searchSentRecipients, type RecentRecipient } from '../api/recent-recipients';
import { jmapClient } from '../api/jmap-client';
import {
  getContactDisplayName,
  getContactKeywords,
  getContactPrimaryEmail,
  getContactSortName,
  isGroup,
  matchesContactSearch,
} from '../lib/contact-utils';
import { sanitizeDisplayName, splitMailbox } from '../lib/rfc5322-mailbox';

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

/** One compose-autocomplete suggestion: a person, or a contact group. */
export interface RecipientSuggestion {
  name: string;
  email: string;
  group?: { id: string; memberCount: number };
}

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

  // People the user has written to (scanned from the Sent folder) for the
  // composer autocomplete.
  recentRecipients: RecentRecipient[];
  recentRecipientsLoaded: boolean;
  sentMailboxId: string | null;

  hydrate: () => Promise<void>;
  fetchAddressBooks: () => Promise<void>;
  fetchContacts: (filter?: { text?: string; inAddressBook?: string }) => Promise<void>;
  refresh: () => Promise<void>;
  handleStateChange: (change: StateChange) => Promise<void>;

  createContact: (contact: Partial<ContactCard>, addressBookId: string) => Promise<ContactCard>;
  updateContact: (id: string, changes: Partial<ContactCard>) => Promise<void>;
  deleteContact: (id: string) => Promise<void>;
  bulkDelete: (ids: string[]) => Promise<void>;
  importContacts: (
    contacts: Partial<ContactCard>[],
    addressBookId: string,
  ) => Promise<{ imported: number; failed: number }>;

  addContactKeyword: (id: string, keyword: string) => Promise<void>;
  removeContactKeyword: (id: string, keyword: string) => Promise<void>;
  addKeywordToContacts: (ids: string[], keyword: string) => Promise<void>;
  renameKeyword: (oldKeyword: string, newKeyword: string) => Promise<void>;
  moveContactsToAddressBook: (ids: string[], addressBookId: string) => Promise<void>;

  // Groups
  addContactsToGroup: (groupId: string, contactIds: string[]) => Promise<void>;
  createGroup: (name: string, memberIds: string[], addressBookId?: string) => Promise<ContactCard>;
  /** Member addresses of a group, one entry per address (case-insensitive). */
  getGroupRecipients: (groupId: string) => EmailAddress[];

  // Address book management
  createAddressBook: (name: string) => Promise<AddressBook>;
  renameAddressBook: (id: string, name: string) => Promise<void>;
  deleteAddressBook: (id: string) => Promise<void>;
  setDefaultAddressBook: (id: string) => Promise<void>;
  /** The book new contacts / imports should land in when none is chosen. */
  getDefaultAddressBookId: () => string | null;

  // Composer autocomplete
  loadRecentRecipients: (sentMailboxId?: string | null) => Promise<void>;
  searchRecipients: (query: string) => Promise<RecipientSuggestion[]>;
  getAutocomplete: (query: string, limit?: number) => RecipientSuggestion[];
  findContactByEmail: (email: string) => ContactCard | undefined;

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

/** Every e-mail address held by the given contacts, lowercased and de-duplicated. */
export function collectContactEmails(contacts: ContactCard[]): string[] {
  const seen = new Set<string>();
  for (const contact of contacts) {
    if (!contact.emails) continue;
    for (const entry of Object.values(contact.emails)) {
      const address = entry.address?.toLowerCase().trim();
      if (address) seen.add(address);
    }
  }
  return Array.from(seen);
}

/** Parse "Name <email>" (or a bare address) into its parts. */
function parseTrustedSenderInput(input: string): { name?: string; email: string } {
  const trimmed = input.trim();
  const angleMatch = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
  const name = angleMatch ? angleMatch[1].trim() : undefined;
  const email = (angleMatch ? angleMatch[2] : trimmed).toLowerCase().trim();
  return { name: name || undefined, email };
}

/**
 * Strip a deleted card's id / uid / `urn:uuid:` variants from every group's
 * member map so drawer counts and group views stop counting it until the next
 * full refresh (webmail cleanGroupMembers).
 */
export function cleanGroupMembers(contacts: ContactCard[], removedIds: Set<string>): ContactCard[] {
  const removedKeys = new Set<string>();
  for (const c of contacts) {
    if (!removedIds.has(c.id)) continue;
    removedKeys.add(c.id);
    if (c.uid) {
      removedKeys.add(c.uid);
      removedKeys.add(c.uid.startsWith('urn:uuid:') ? c.uid.slice(9) : c.uid);
    }
    if (c.originalId) removedKeys.add(c.originalId);
  }
  if (removedKeys.size === 0) return contacts;
  return contacts.map((c) => {
    if (c.kind !== 'group' || !c.members) return c;
    let changed = false;
    const newMembers: Record<string, boolean> = {};
    for (const [key, val] of Object.entries(c.members)) {
      const bareKey = key.startsWith('urn:uuid:') ? key.slice(9) : key;
      if (removedKeys.has(key) || removedKeys.has(bareKey)) {
        changed = true;
      } else {
        newMembers[key] = val;
      }
    }
    return changed ? { ...c, members: newMembers } : c;
  });
}

/**
 * Reduces every suggestion to a clean display name plus a bare address and
 * collapses the ones that resolve to the same address (webmail #672). Groups
 * carry no address and pass through untouched.
 */
export function normalizeSuggestions(results: RecipientSuggestion[]): RecipientSuggestion[] {
  const out: RecipientSuggestion[] = [];
  const indexByEmail = new Map<string, number>();
  for (const r of results) {
    if (r.group) {
      out.push(r);
      continue;
    }
    const mailbox = splitMailbox(r.email);
    if (!mailbox.email) continue;
    const name = sanitizeDisplayName(r.name) || mailbox.name || '';
    const suggestion = { name: name === mailbox.email ? '' : name, email: mailbox.email };
    const key = mailbox.email.toLowerCase();
    const seenAt = indexByEmail.get(key);
    if (seenAt === undefined) {
      indexByEmail.set(key, out.length);
      out.push(suggestion);
    } else if (!out[seenAt].name && suggestion.name) {
      out[seenAt].name = suggestion.name;
    }
  }
  return out;
}

// In-flight loads shared by every caller so a cold start cannot fire two
// AddressBook/get or ContactCard/query requests at once (Stalwart mints its
// default collections lazily on first touch, #907) and a "trust sender" tap
// never races the passive trusted-senders load.
let addressBooksPromise: Promise<void> | null = null;
let contactsPromise: Promise<void> | null = null;
let trustedSendersPromise: Promise<void> | null = null;

export const useContactsStore = create<ContactsState>()(
  persist(
    (set, get) => {
      /** Server-side id + owning account for a card in state. */
      const contactTarget = (id: string): { originalId: string; accountId?: string } => {
        const contact = get().contacts.find((c) => c.id === id);
        return {
          originalId: contact?.originalId || id,
          accountId: contact?.isShared ? contact.accountId : undefined,
        };
      };

      /** Server-side id + owning account for an address book in state. */
      const bookTarget = (bookId: string): { originalId: string; accountId?: string; book?: AddressBook } => {
        const book = get().addressBooks.find((b) => b.id === bookId);
        return {
          originalId: book?.originalId || bookId,
          accountId: book?.isShared ? book.accountId : undefined,
          book,
        };
      };

      /** Tag a freshly created card with the account metadata its book carries. */
      const tagCreated = (created: ContactCard, book: AddressBook | undefined): ContactCard => {
        if (!book?.isShared || !book.accountId) return created;
        const accountId = book.accountId;
        return {
          ...created,
          id: namespaceId(accountId, created.id),
          originalId: created.id,
          addressBookIds: Object.fromEntries(
            Object.entries(created.addressBookIds || {}).map(([k, v]) => [namespaceId(accountId, k), v]),
          ),
          accountId,
          accountName: book.accountName,
          isShared: true,
        };
      };

      /** De-namespace `addressBookIds` of a shared card before sending a patch. */
      const cleanPatch = (contact: ContactCard | undefined, changes: Partial<ContactCard>): Partial<ContactCard> => {
        if (!contact?.isShared || !contact.accountId || !changes.addressBookIds) return changes;
        const prefix = `${contact.accountId}:`;
        return {
          ...changes,
          addressBookIds: Object.fromEntries(
            Object.entries(changes.addressBookIds).map(([k, v]) => [k.startsWith(prefix) ? k.slice(prefix.length) : k, v]),
          ),
        };
      };

      const loadAddressBooks = async (): Promise<void> => {
        try {
          const addressBooks = (await fetchAllAddressBooks()) ?? [];
          set({ addressBooks });
        } catch (err) {
          set({ error: err instanceof Error ? err.message : 'Failed to load address books' });
        }
      };

      return {
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

        recentRecipients: [],
        recentRecipientsLoaded: false,
        sentMailboxId: null,

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
          if (addressBooksPromise) return addressBooksPromise;
          addressBooksPromise = loadAddressBooks().finally(() => {
            addressBooksPromise = null;
          });
          return addressBooksPromise;
        },

        fetchContacts: async (filter) => {
          if (!jmapClient.isConnected) return;
          if (contactsPromise) return contactsPromise;
          contactsPromise = (async () => {
            // Books first: AddressBook/get is the call that makes Stalwart mint
            // the default book, so ContactCard/query must never run alongside it.
            if (addressBooksPromise) await addressBooksPromise;
            set({ loading: true, error: null });
            try {
              let contacts: ContactCard[];
              if (filter && Object.keys(filter).length > 0) {
                const ids = (await queryContacts(filter)) ?? [];
                contacts = ids.length > 0 ? ((await fetchContactsByIds(ids)) ?? []) : [];
              } else {
                contacts = (await fetchAllContacts()) ?? [];
              }
              set({ contacts, loading: false });
            } catch (err) {
              set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load contacts' });
            }
          })().finally(() => {
            contactsPromise = null;
          });
          return contactsPromise;
        },

        refresh: async () => {
          await get().fetchContacts();
        },

        handleStateChange: async (change) => {
          if (!jmapClient.isConnected) return;
          let addressBookChanged = false;
          let contactChanged = false;
          for (const accountId of getContactCapableAccountIds()) {
            const accountChanges = change.changed?.[accountId];
            if (!accountChanges) continue;
            if ('AddressBook' in accountChanges) addressBookChanged = true;
            if ('ContactCard' in accountChanges || 'Contact' in accountChanges) contactChanged = true;
          }
          if (!addressBookChanged && !contactChanged) return;

          if (addressBookChanged) {
            await get().fetchAddressBooks();
          }
          if (contactChanged) {
            await get().refresh();
          }
        },

        createContact: async (contact, addressBookId) => {
          const { originalId, accountId, book } = bookTarget(addressBookId);
          const created = tagCreated(await apiCreateContact(contact, originalId, accountId), book);
          set({ contacts: [...get().contacts, created] });
          return created;
        },

        updateContact: async (id, changes) => {
          const contact = get().contacts.find((c) => c.id === id);
          const { originalId, accountId } = contactTarget(id);
          await apiUpdateContact(originalId, cleanPatch(contact, changes), accountId);
          set({
            contacts: get().contacts.map((c) => {
              if (c.id !== id) return c;
              const merged: ContactCard = { ...c, ...changes };
              // A `null` patch value clears the property (JMAP semantics);
              // mirror that locally so the UI doesn't resurrect the old value.
              for (const [key, value] of Object.entries(changes)) {
                if (value === null) delete (merged as unknown as Record<string, unknown>)[key];
              }
              return merged;
            }),
          });
        },

        deleteContact: async (id) => {
          const { originalId, accountId } = contactTarget(id);
          await apiDeleteContacts([originalId], accountId);
          set({ contacts: cleanGroupMembers(get().contacts, new Set([id])).filter((c) => c.id !== id) });
        },

        bulkDelete: async (ids) => {
          if (ids.length === 0) return;
          // Group by owning account; each account gets one ContactCard/set.
          const byAccount = new Map<string | undefined, Array<{ id: string; originalId: string }>>();
          for (const id of ids) {
            const { originalId, accountId } = contactTarget(id);
            const list = byAccount.get(accountId) ?? [];
            list.push({ id, originalId });
            byAccount.set(accountId, list);
          }
          const removed = new Set<string>();
          let failed = 0;
          for (const [accountId, entries] of byAccount) {
            try {
              const destroyed = new Set(
                await apiDeleteContacts(entries.map((e) => e.originalId), accountId),
              );
              for (const e of entries) {
                if (destroyed.has(e.originalId)) removed.add(e.id);
                else failed++;
              }
            } catch (err) {
              console.warn('[contacts-store] bulk delete failed', err);
              failed += entries.length;
            }
          }
          set({
            contacts: cleanGroupMembers(get().contacts, removed).filter((c) => !removed.has(c.id)),
            ...(failed > 0 ? { error: `Failed to delete ${failed} contact${failed === 1 ? '' : 's'}` } : {}),
          });
        },

        importContacts: async (incoming, addressBookId) => {
          let imported = 0;
          let failed = 0;
          const { originalId, accountId, book } = bookTarget(addressBookId);
          for (const contact of incoming) {
            try {
              // Strip the temporary client-side id; the server assigns a real one.
              const { id: _id, addressBookIds: _abIds, ...data } = contact;
              const created = tagCreated(await apiCreateContact(data, originalId, accountId), book);
              set({ contacts: [...get().contacts, created] });
              imported++;
            } catch (err) {
              failed++;
              console.warn('[contacts-store] import failed for one contact', err);
            }
          }
          return { imported, failed };
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

        renameKeyword: async (oldKeyword, newKeyword) => {
          const oldKw = oldKeyword.trim();
          const newKw = newKeyword.trim();
          if (!oldKw || !newKw || oldKw === newKw) return;
          const affected = get().contacts.filter((c) => c.keywords?.[oldKw]);
          for (const contact of affected) {
            const { [oldKw]: _old, ...rest } = contact.keywords || {};
            await get().updateContact(contact.id, { keywords: { ...rest, [newKw]: true } });
          }
          const category = get().selectedCategory;
          if (category.type === 'keyword' && category.keyword === oldKw) {
            get().setSelectedCategory({ type: 'keyword', keyword: newKw });
          }
        },

        moveContactsToAddressBook: async (ids, addressBookId) => {
          const target = bookTarget(addressBookId);
          const primaryAccountId = getContactsAccountId();
          const targetAccount = target.accountId || primaryAccountId;
          for (const id of ids) {
            const contact = get().contacts.find((c) => c.id === id);
            if (!contact) continue;
            const source = contactTarget(id);
            const sourceAccount = source.accountId || primaryAccountId;
            if (sourceAccount === targetAccount) {
              await apiUpdateContact(source.originalId, { addressBookIds: { [target.originalId]: true } }, source.accountId);
              set({
                contacts: get().contacts.map((c) =>
                  c.id === id ? { ...c, addressBookIds: { [addressBookId]: true } } : c,
                ),
              });
            } else {
              // Cross-account: create in the target account, then delete the source.
              const { id: _id, addressBookIds: _ab, uid: _uid, created: _c, updated: _u, ...data } = stripClientFields(contact);
              const created = tagCreated(await apiCreateContact(data, target.originalId, target.accountId), target.book);
              await apiDeleteContacts([source.originalId], source.accountId);
              set({ contacts: get().contacts.map((c) => (c.id === id ? created : c)) });
            }
          }
        },

        addContactsToGroup: async (groupId, contactIds) => {
          const group = get().contacts.find((c) => c.id === groupId);
          if (!group) throw new Error('Group not found');
          const members = { ...(group.members || {}) };
          for (const id of contactIds) {
            const contact = get().contacts.find((c) => c.id === id);
            if (!contact || isGroup(contact)) continue;
            // Members are referenced by UID (RFC 9553 §2.1.6); fall back to the
            // id for legacy cards that never got one (#644).
            members[contact.uid || contact.originalId || contact.id] = true;
          }
          await get().updateContact(groupId, { members });
        },

        createGroup: async (name, memberIds, addressBookId) => {
          const trimmed = name.trim();
          if (!trimmed) throw new Error('Group name is required');
          const bookId = addressBookId || get().getDefaultAddressBookId();
          if (!bookId) throw new Error('No address book available');
          const members: Record<string, boolean> = {};
          for (const id of memberIds) {
            const contact = get().contacts.find((c) => c.id === id);
            if (!contact || isGroup(contact)) continue;
            members[contact.uid || contact.originalId || contact.id] = true;
          }
          return get().createContact(
            {
              kind: 'group',
              name: { components: [{ kind: 'given', value: trimmed }], isOrdered: true, full: trimmed },
              members,
            },
            bookId,
          );
        },

        getGroupRecipients: (groupId) => {
          const members = selectGroupMembers(get(), groupId);
          const seen = new Set<string>();
          const out: EmailAddress[] = [];
          for (const m of members) {
            if (isGroup(m)) continue;
            const email = getContactPrimaryEmail(m).trim();
            const key = email.toLowerCase();
            if (!email || seen.has(key)) continue;
            seen.add(key);
            const name = sanitizeDisplayName(getContactDisplayName(m));
            out.push({ name: name && name !== email ? name : '', email });
          }
          return out;
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
          const { originalId, accountId } = bookTarget(id);
          await apiUpdateAddressBook(originalId, { name: trimmed }, accountId);
          set({
            addressBooks: get().addressBooks.map((b) => (b.id === id ? { ...b, name: trimmed } : b)),
          });
        },

        deleteAddressBook: async (id) => {
          const { originalId, accountId } = bookTarget(id);
          await apiDeleteAddressBook(originalId, accountId);
          // Stalwart destroys the cards filed in the book along with it, so
          // drop them from the cache instead of leaving orphans under "All".
          set({
            addressBooks: get().addressBooks.filter((b) => b.id !== id),
            contacts: get().contacts.filter((c) => !c.addressBookIds?.[id]),
          });
          const category = get().selectedCategory;
          if (category.type === 'addressBook' && category.addressBookId === id) {
            get().setSelectedCategory({ type: 'all' });
          }
        },

        setDefaultAddressBook: async (id) => {
          const { originalId, accountId, book } = bookTarget(id);
          await apiSetDefaultAddressBook(originalId, accountId);
          set({
            addressBooks: get().addressBooks.map((b) => {
              if (b.id === id) return { ...b, isDefault: true };
              // Only one default per account - clear the flag on siblings.
              if (b.isDefault && (b.accountId ?? null) === (book?.accountId ?? null)) {
                return { ...b, isDefault: false };
              }
              return b;
            }),
          });
        },

        getDefaultAddressBookId: () => {
          const books = get().addressBooks;
          const own = books.filter((b) => !b.isShared && b.myRights?.mayWrite !== false);
          const candidates = own.length > 0 ? own : books.filter((b) => b.myRights?.mayWrite !== false);
          return (candidates.find((b) => b.isDefault) || candidates[0])?.id ?? null;
        },

        loadRecentRecipients: async (sentMailboxId) => {
          if (sentMailboxId) set({ sentMailboxId });
          const mailboxId = get().sentMailboxId;
          if (get().recentRecipientsLoaded || !mailboxId || !jmapClient.isConnected) return;
          try {
            const recentRecipients = await queryRecentRecipients(mailboxId, 300);
            set({ recentRecipients, recentRecipientsLoaded: true });
          } catch (err) {
            console.warn('[contacts-store] load recent recipients failed', err);
            set({ recentRecipientsLoaded: true });
          }
        },

        searchRecipients: async (query) => {
          const mailboxId = get().sentMailboxId;
          const q = query.trim();
          if (!mailboxId || !q || !jmapClient.isConnected) return [];
          try {
            return normalizeSuggestions(await searchSentRecipients(q, mailboxId));
          } catch (err) {
            console.warn('[contacts-store] recipient search failed', err);
            return [];
          }
        },

        getAutocomplete: (query, limit = 10) => {
          const q = query.trim().toLowerCase();
          if (!q) return [];
          const { contacts, recentRecipients } = get();
          const results: RecipientSuggestion[] = [];

          for (const contact of contacts) {
            if (results.length >= limit) break;
            if (isGroup(contact)) {
              // Suggest the group itself as a single entry (Outlook-style);
              // picking it expands to the member addresses.
              const groupName = getContactDisplayName(contact);
              if (groupName && groupName.toLowerCase().includes(q)) {
                const memberCount = get().getGroupRecipients(contact.id).length;
                if (memberCount > 0) {
                  results.push({ name: groupName, email: '', group: { id: contact.id, memberCount } });
                }
              }
              continue;
            }
            const name = getContactDisplayName(contact);
            const emails = contact.emails ? Object.values(contact.emails) : [];
            for (const entry of emails) {
              if (!entry.address) continue;
              if (name.toLowerCase().includes(q) || entry.address.toLowerCase().includes(q)) {
                results.push({ name, email: entry.address });
              }
            }
          }

          // Fold in recent recipients from the Sent folder. Contacts take
          // precedence, so skip any address already suggested.
          if (recentRecipients.length > 0 && results.length < limit) {
            const seen = new Set(results.map((r) => r.email.toLowerCase()));
            for (const rec of recentRecipients) {
              if (results.length >= limit) break;
              const addr = rec.email.toLowerCase();
              if (seen.has(addr)) continue;
              if (addr.includes(q) || rec.name.toLowerCase().includes(q)) {
                results.push({ name: rec.name, email: rec.email });
                seen.add(addr);
              }
            }
          }

          return normalizeSuggestions(results);
        },

        findContactByEmail: (email) => {
          const needle = splitMailbox(email).email.toLowerCase().trim();
          if (!needle) return undefined;
          return get().contacts.find((c) =>
            !isGroup(c) && !!c.emails
              && Object.values(c.emails).some((e) => e.address?.toLowerCase().trim() === needle));
        },

        loadTrustedSendersBook: async (createIfMissing = false) => {
          if (!jmapClient.isConnected) return;
          // Share the in-flight load so parallel callers (mail view, settings,
          // addToTrustedSendersBook) never create the book twice - and so a
          // caller that needs the book id can wait for it instead of failing.
          if (trustedSendersPromise) await trustedSendersPromise;
          if (get().trustedSendersBookId) return;
          if (get().trustedSendersLoaded && !createIfMissing) return;

          set({ trustedSendersLoading: true });
          trustedSendersPromise = (async () => {
            try {
              // Must throw rather than yield [] on failure: treating a failed
              // fetch as "no book yet" minted a duplicate on every hiccup (#730).
              const books = (await fetchPrimaryAddressBooks()) ?? [];
              // Sort so every client picks the same book when duplicates exist.
              const matches = books
                .filter((b) => b.name === TRUSTED_SENDERS_BOOK_NAME)
                .sort((a, b) => a.id.localeCompare(b.id));
              let book = matches[0];
              if (!book) {
                if (!createIfMissing) {
                  set({ trustedSendersLoaded: true, trustedSendersLoading: false });
                  return;
                }
                book = await apiCreateAddressBook(TRUSTED_SENDERS_BOOK_NAME);
              }
              const bookId = book.id;
              const cards = await getContactsInBook(bookId);
              set({
                trustedSendersBookId: bookId,
                trustedSenderEmails: collectContactEmails(cards),
                trustedSendersLoaded: true,
                trustedSendersLoading: false,
              });
            } catch (err) {
              console.warn('[contacts-store] load trusted senders failed', err);
              set({ trustedSendersLoaded: true, trustedSendersLoading: false });
            }
          })().finally(() => {
            trustedSendersPromise = null;
          });
          return trustedSendersPromise;
        },

        addToTrustedSendersBook: async (input) => {
          const { name, email } = parseTrustedSenderInput(input);
          if (!email || get().trustedSenderEmails.includes(email)) return;

          let bookId = get().trustedSendersBookId;
          if (!bookId) {
            await get().loadTrustedSendersBook(true);
            bookId = get().trustedSendersBookId;
          }
          if (!bookId) throw new Error('Could not find or create the trusted senders address book');
          // The load may have found the address already filed in the book.
          if (get().trustedSenderEmails.includes(email)) return;

          await apiCreateContact(
            {
              ...(name ? { name: { full: name } } : {}),
              emails: { email: { address: email } },
            },
            bookId,
          );
          set({ trustedSenderEmails: [...get().trustedSenderEmails, email] });
        },

        removeFromTrustedSendersBook: async (input) => {
          const { email } = parseTrustedSenderInput(input);
          const bookId = get().trustedSendersBookId;
          if (!bookId || !email) return;
          const cards = await getContactsInBook(bookId);
          const matches = cards.filter((c) =>
            c.emails && Object.values(c.emails).some((e) => e.address?.toLowerCase().trim() === email));
          if (matches.length > 0) await apiDeleteContacts(matches.map((m) => m.id));
          set({ trustedSenderEmails: get().trustedSenderEmails.filter((e) => e !== email) });
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
          recentRecipients: [],
          recentRecipientsLoaded: false,
          sentMailboxId: null,
        }),
      };
    },
    {
      // Persist address books and contact cards so the list renders instantly
      // on re-open. A refresh runs in the background once the JMAP session is
      // ready and replaces the cached data.
      name: 'contacts-cache',
      storage: createPersistStorage(),
      partialize: memoizeSlice(
        (state: ContactsState) => [state.addressBooks, state.contacts],
        (state) => ({
          addressBooks: state.addressBooks,
          // Photos are inline base64 blobs; a few hundred of them blow past
          // Android AsyncStorage's write cap and the cache silently stops
          // updating. They are re-hydrated from the server on refresh.
          contacts: state.contacts.map(({ media: _media, ...rest }) => rest),
        }),
      ),
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

export function selectKeywordsUsed(contacts: ContactCard[]): Array<{ keyword: string; count: number }> {
  const counts = new Map<string, number>();
  for (const contact of contacts) {
    for (const kw of getContactKeywords(contact)) {
      counts.set(kw, (counts.get(kw) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([keyword, count]) => ({ keyword, count }))
    .sort((a, b) => a.keyword.localeCompare(b.keyword));
}

/** Contacts without any category (keyword) - the webmail's "No category". */
export function selectUncategorized(contacts: ContactCard[]): ContactCard[] {
  return contacts.filter((c) => !isGroup(c) && getContactKeywords(c).length === 0);
}

export function selectAddressBooksWithCount(
  addressBooks: AddressBook[],
  contacts: ContactCard[],
): Array<AddressBook & { count: number }> {
  return addressBooks.map((book) => ({
    ...book,
    count: contacts.filter((c) => !isGroup(c) && c.addressBookIds?.[book.id]).length,
  }));
}

export function selectGroupMembers(state: Pick<ContactsState, 'contacts'>, groupId: string): ContactCard[] {
  const group = state.contacts.find((c) => c.id === groupId);
  if (!group?.members) return [];
  const memberKeys = Object.keys(group.members).filter((k) => group.members![k]);
  const normalized = memberKeys.map((k) => (k.startsWith('urn:uuid:') ? k.slice(9) : k));
  const keySet = new Set([...memberKeys, ...normalized]);
  return state.contacts.filter((c) => {
    if (keySet.has(c.id)) return true;
    if (c.originalId && keySet.has(c.originalId)) return true;
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
      filtered = selectUncategorized(individuals);
      break;
    default:
      filtered = individuals;
  }

  if (!query) return filtered;
  return filtered.filter((c) => matchesContactSearch(c, query));
}

export function sortContactsByDisplayName(contacts: ContactCard[]): ContactCard[] {
  return sortContactsByName(contacts, false);
}

/** Contact list order: by display name, or surname first with `byLastName` (#963). */
export function sortContactsByName(contacts: ContactCard[], byLastName: boolean): ContactCard[] {
  return [...contacts].sort((a, b) =>
    getContactSortName(a, byLastName).localeCompare(getContactSortName(b, byLastName), undefined, { sensitivity: 'base' }),
  );
}
