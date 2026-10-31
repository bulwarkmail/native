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
  getContactMedia as apiGetContactMedia,
  namespaceId,
  stripClientFields,
} from '../api/contacts';
import { inlineContactMedia, writeContactWithNewPhoto, type ContactSaveOptions } from '../lib/contact-media';
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
import { listPrincipals, supportsSharing } from '../api/files';
import {
  directorySuggestions,
  principalsToDirectory,
  type DirectoryEntry,
  type DirectoryStatus,
} from '../lib/contact-directory';
import { requestDeviceSync } from '../device-sync/app/request';
import { CONTACTS_AUTHORITY } from '../device-sync/types';

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
  /** When `contacts` last got every card from the server (0 = not this session). */
  contactsFetchedAt: number;

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

  // The company directory (#1253): principals the server lists, read-only.
  directory: DirectoryEntry[];
  directoryStatus: DirectoryStatus;
  /**
   * The server refused the listing because its administrator keeps directory
   * queries off (Stalwart 1.0's default), not over this account's rights.
   */
  directoryQueriesOff: boolean;

  hydrate: () => Promise<void>;
  fetchAddressBooks: () => Promise<void>;
  fetchContacts: (filter?: { text?: string; inAddressBook?: string }) => Promise<void>;
  /** `fetchContacts()` unless every card was fetched within `CONTACTS_STALE_MS`. */
  fetchContactsIfStale: () => Promise<void>;
  refresh: () => Promise<void>;
  handleStateChange: (change: StateChange) => Promise<void>;

  /** `options.photoKey` names the `media` entry holding a newly picked photo. */
  createContact: (
    contact: Partial<ContactCard>,
    addressBookId: string,
    options?: ContactSaveOptions,
  ) => Promise<ContactCard>;
  updateContact: (id: string, changes: Partial<ContactCard>, options?: ContactSaveOptions) => Promise<void>;
  /** The card's `media` as the server has it now, or null when it can't be read. */
  fetchContactMedia: (id: string) => Promise<Pick<ContactCard, 'media'> | null>;
  deleteContact: (id: string) => Promise<void>;
  bulkDelete: (ids: string[]) => Promise<void>;
  /**
   * Creates the cards in the book. One whose UID the account already has is
   * updated in place instead (a re-import of an export), but only when its
   * UID is in `updateUids`: the user chose to replace that card. Any other
   * card whose UID is taken is not written and counts as failed.
   */
  importContacts: (
    contacts: Partial<ContactCard>[],
    addressBookId: string,
    updateUids?: ReadonlySet<string>,
  ) => Promise<ContactImportResult>;

  addContactKeyword: (id: string, keyword: string) => Promise<void>;
  removeContactKeyword: (id: string, keyword: string) => Promise<void>;
  addKeywordToContacts: (ids: string[], keyword: string) => Promise<void>;
  renameKeyword: (oldKeyword: string, newKeyword: string) => Promise<void>;
  /**
   * Delete a category: take it off every contact that has it. Resolves to
   * the contacts it came off, for an Undo (webmail 1.19 removeKeyword).
   */
  removeKeyword: (keyword: string) => Promise<string[]>;
  /** Put a category back on these contacts (the Undo of removeKeyword). */
  addKeyword: (keyword: string, contactIds: string[]) => Promise<void>;
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
  /** Load the company directory (the server's principals). */
  fetchDirectory: () => Promise<void>;
  /**
   * Directory people matching what is typed, for recipient fields. Reads what
   * fetchDirectory loaded; empty until then.
   */
  lookupDirectory: (query: string, limit?: number) => RecipientSuggestion[];

  // Trusted senders address book. Passive loads (createIfMissing=false) only
  // read an existing book; the book is created lazily on the first add.
  loadTrustedSendersBook: (createIfMissing?: boolean) => Promise<void>;
  addToTrustedSendersBook: (email: string) => Promise<void>;
  removeFromTrustedSendersBook: (email: string) => Promise<void>;
  isTrustedAddressBookSender: (email: string) => boolean;

  setSelectedCategory: (category: ContactCategory) => void;
  reset: () => void;
}

/** A card an import could not save, and the server's reason. */
export interface ContactImportFailure {
  name: string;
  reason: string;
}

export interface ContactImportResult {
  imported: number;
  /** Cards whose UID the account already had, updated in place. */
  updated: number;
  failed: number;
  failures: ContactImportFailure[];
}

/**
 * The card a create was refused for because its UID is taken, as Stalwart
 * names it (0.16 and 1.0): "Contact with UID urn:uuid:... already exists
 * with id b."
 */
export function existingUidCardId(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const m = /already exists with id ([^\s.]+)/i.exec(err.message);
  return m ? m[1] : null;
}

/** The account's cards by UID; `accountId` undefined is the own account. */
function cardsByUid(contacts: ContactCard[], accountId: string | undefined): Map<string, ContactCard> {
  const byUid = new Map<string, ContactCard>();
  for (const c of contacts) {
    // As the server compares them: "x" and "urn:uuid:x" are two UIDs.
    if (c.uid && (c.isShared ? c.accountId : undefined) === accountId) byUid.set(c.uid, c);
  }
  return byUid;
}

/**
 * The cards an import into `addressBookId` would replace: its account holds
 * one with the incoming card's UID, in whatever book. That may be another
 * contact altogether (an older export, another app's "1", "2" UIDs), so the
 * import sheet asks first. Keyed by the incoming card's index.
 */
export function selectImportUidMatches(
  state: Pick<ContactsState, 'contacts' | 'addressBooks'>,
  incoming: Partial<ContactCard>[],
  addressBookId: string | null,
): Map<number, ContactCard> {
  const book = state.addressBooks.find((b) => b.id === addressBookId);
  const byUid = cardsByUid(state.contacts, book?.isShared ? book.accountId : undefined);
  const matches = new Map<number, ContactCard>();
  incoming.forEach((card, idx) => {
    const known = card.uid ? byUid.get(card.uid) : undefined;
    if (known) matches.set(idx, known);
  });
  return matches;
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
let directoryPromise: Promise<void> | null = null;

// One up with every reset (an account switch, a sign-out), as in the calendar
// store. The client is one singleton that serves whichever account is active,
// so a load or a write still under way from before must keep what it read to
// itself: landing after the switch, it put the previous account's cards and
// books under the next one, and a loop of writes went on in the new account.
let storeGeneration = 0;

/** The store was reset (another account) while a contacts write was under way. */
export class ContactsAccountChangedError extends Error {
  constructor() {
    super('The account changed while the contacts were being saved');
    this.name = 'ContactsAccountChangedError';
  }
}

/** For one load or write: whether a reset has overtaken it since it started. */
function generationGuard() {
  const generation = storeGeneration;
  const stale = () => generation !== storeGeneration;
  return {
    stale,
    /** Throws ContactsAccountChangedError once stale: nothing more may be sent or kept. */
    check: () => {
      if (stale()) throw new ContactsAccountChangedError();
    },
  };
}

// Startup fetches every card and live `ContactCard` state changes refetch
// them, so opening Contacts only downloads the cards again once the last full
// fetch is this old - it covers changes missed while the app was in the
// background or live updates were down (PF6).
export const CONTACTS_STALE_MS = 5 * 60_000;

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
        const { stale } = generationGuard();
        try {
          const addressBooks = (await fetchAllAddressBooks()) ?? [];
          if (stale()) return;
          set({ addressBooks });
        } catch (err) {
          if (stale()) return;
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
        contactsFetchedAt: 0,

        trustedSendersBookId: null,
        trustedSenderEmails: [],
        trustedSendersLoaded: false,
        trustedSendersLoading: false,

        recentRecipients: [],
        recentRecipientsLoaded: false,
        sentMailboxId: null,

        directory: [],
        directoryStatus: 'idle',
        directoryQueriesOff: false,

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
          const promise = loadAddressBooks().finally(() => {
            // A reset may have handed the slot to the next account's load.
            if (addressBooksPromise === promise) addressBooksPromise = null;
          });
          addressBooksPromise = promise;
          return promise;
        },

        fetchContacts: async (filter) => {
          if (!jmapClient.isConnected) return;
          if (contactsPromise) return contactsPromise;
          const { stale } = generationGuard();
          const promise: Promise<void> = (async () => {
            // Books first: AddressBook/get is the call that makes Stalwart mint
            // the default book, so ContactCard/query must never run alongside it.
            if (addressBooksPromise) await addressBooksPromise;
            if (stale()) return;
            set({ loading: true, error: null });
            try {
              let contacts: ContactCard[];
              const filtered = !!filter && Object.keys(filter).length > 0;
              if (filtered) {
                const ids = (await queryContacts(filter)) ?? [];
                contacts = ids.length > 0 ? ((await fetchContactsByIds(ids)) ?? []) : [];
              } else {
                contacts = (await fetchAllContacts()) ?? [];
              }
              if (stale()) return;
              // A filtered load leaves only some of the cards in state.
              set({ contacts, loading: false, contactsFetchedAt: filtered ? 0 : Date.now() });
            } catch (err) {
              if (stale()) return;
              set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load contacts' });
            }
          })().finally(() => {
            if (contactsPromise === promise) contactsPromise = null;
          });
          contactsPromise = promise;
          return promise;
        },

        fetchContactsIfStale: async () => {
          const fetchedAt = get().contactsFetchedAt;
          if (fetchedAt > 0 && Date.now() - fetchedAt < CONTACTS_STALE_MS) return;
          await get().fetchContacts();
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

        createContact: async (contact, addressBookId, options) => {
          const { check } = generationGuard();
          const { originalId, accountId, book } = bookTarget(addressBookId);
          // The photo goes up first; the card must not follow it into the next account.
          const write = (card: Partial<ContactCard>) => { check(); return apiCreateContact(card, originalId, accountId); };
          const saved = options?.photoKey
            ? await writeContactWithNewPhoto(accountId, contact, options.photoKey, write)
            : await write(contact);
          const created = tagCreated(saved, book);
          check();
          set({ contacts: [...get().contacts, created] });
          requestDeviceSync(CONTACTS_AUTHORITY);
          return created;
        },

        updateContact: async (id, changes, options) => {
          const contact = get().contacts.find((c) => c.id === id);
          const { originalId, accountId } = contactTarget(id);
          const patch = cleanPatch(contact, changes);
          const { check } = generationGuard();
          const write = (card: Partial<ContactCard>) => { check(); return apiUpdateContact(originalId, card, accountId); };
          if (options?.photoKey) {
            await writeContactWithNewPhoto(accountId, patch, options.photoKey, write);
          } else {
            await write(patch);
          }
          check();
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
          requestDeviceSync(CONTACTS_AUTHORITY);
        },

        fetchContactMedia: async (id) => {
          const { originalId, accountId } = contactTarget(id);
          try {
            const media = await apiGetContactMedia(originalId, accountId);
            return media === undefined ? null : { media: media ?? undefined };
          } catch (err) {
            console.warn('[contacts-store] reading the card media failed', err);
            return null;
          }
        },

        deleteContact: async (id) => {
          const { check } = generationGuard();
          const { originalId, accountId } = contactTarget(id);
          await apiDeleteContacts([originalId], accountId);
          check();
          set({ contacts: cleanGroupMembers(get().contacts, new Set([id])).filter((c) => c.id !== id) });
          requestDeviceSync(CONTACTS_AUTHORITY);
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
          const { check } = generationGuard();
          for (const [accountId, entries] of byAccount) {
            check();
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
          check();
          set({
            contacts: cleanGroupMembers(get().contacts, removed).filter((c) => !removed.has(c.id)),
            ...(failed > 0 ? { error: `Failed to delete ${failed} contact${failed === 1 ? '' : 's'}` } : {}),
          });
          if (removed.size > 0) requestDeviceSync(CONTACTS_AUTHORITY);
        },

        importContacts: async (incoming, addressBookId, updateUids) => {
          let imported = 0;
          let updated = 0;
          let refetch = false;
          const failures: ContactImportFailure[] = [];
          const { originalId, accountId, book } = bookTarget(addressBookId);
          const { check } = generationGuard();
          // Stalwart keeps one card per UID in an account and refuses a second
          // ("Contact with UID ... already exists"), so re-importing an export
          // failed card by card. A card the account already has is updated,
          // when the user chose to: the same UID may be another contact.
          const byUid = cardsByUid(get().contacts, accountId);
          const mayUpdate = (uid: string | undefined) => !!uid && !!updateUids?.has(uid);
          const updateExisting = async (serverId: string, data: Partial<ContactCard>) => {
            // The card stays in its own book and keeps its UID.
            const { uid: _uid, ...patch } = data;
            await apiUpdateContact(serverId, patch, accountId);
            check();
            const storeId = accountId ? namespaceId(accountId, serverId) : serverId;
            if (!get().contacts.some((c) => c.id === storeId)) {
              refetch = true;
              return;
            }
            set({ contacts: get().contacts.map((c) => (c.id === storeId ? { ...c, ...patch } : c)) });
          };
          for (const contact of incoming) {
            check();
            // Strip the temporary client-side id; the server assigns a real one.
            const { id: _id, addressBookIds: _abIds, ...data } = contact;
            const known = data.uid ? byUid.get(data.uid) : undefined;
            try {
              if (known) {
                if (!mayUpdate(data.uid)) throw new Error(`A contact with UID ${data.uid} already exists`);
                await updateExisting(known.originalId || known.id, data);
                updated++;
                continue;
              }
              let created: ContactCard;
              try {
                created = tagCreated(await apiCreateContact(data, originalId, accountId), book);
              } catch (err) {
                // A card with this UID the list does not hold (not loaded yet,
                // or in another book): the server names it.
                const existingId = existingUidCardId(err);
                if (!existingId || !mayUpdate(data.uid)) throw err;
                await updateExisting(existingId, data);
                updated++;
                continue;
              }
              check();
              set({ contacts: [...get().contacts, created] });
              imported++;
            } catch (err) {
              if (err instanceof ContactsAccountChangedError) throw err;
              console.warn('[contacts-store] import failed for one contact', err);
              failures.push({
                name: getContactDisplayName(contact as ContactCard) || getContactPrimaryEmail(contact as ContactCard),
                reason: err instanceof Error ? err.message : String(err),
              });
            }
          }
          if (imported > 0 || updated > 0) requestDeviceSync(CONTACTS_AUTHORITY);
          if (refetch) void get().fetchContacts();
          return { imported, updated, failed: failures.length, failures };
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

        removeKeyword: async (keyword) => {
          const kw = keyword.trim();
          if (!kw) return [];
          const done: string[] = [];
          for (const contact of get().contacts.filter((c) => c.keywords?.[kw])) {
            const { [kw]: _gone, ...rest } = contact.keywords || {};
            // Through the normal update, so each contact goes to its own account.
            await get().updateContact(contact.id, { keywords: rest });
            done.push(contact.id);
          }
          const category = get().selectedCategory;
          if (category.type === 'keyword' && category.keyword === kw) get().setSelectedCategory({ type: 'all' });
          return done;
        },

        addKeyword: async (keyword, contactIds) => {
          const kw = keyword.trim();
          if (!kw) return;
          for (const id of contactIds) {
            const contact = get().contacts.find((c) => c.id === id);
            if (!contact || contact.keywords?.[kw]) continue;
            await get().updateContact(id, { keywords: { ...(contact.keywords || {}), [kw]: true } });
          }
        },

        moveContactsToAddressBook: async (ids, addressBookId) => {
          const target = bookTarget(addressBookId);
          const primaryAccountId = getContactsAccountId();
          const targetAccount = target.accountId || primaryAccountId;
          const { check } = generationGuard();
          for (const id of ids) {
            check();
            const contact = get().contacts.find((c) => c.id === id);
            if (!contact) continue;
            const source = contactTarget(id);
            const sourceAccount = source.accountId || primaryAccountId;
            if (sourceAccount === targetAccount) {
              await apiUpdateContact(source.originalId, { addressBookIds: { [target.originalId]: true } }, source.accountId);
              check();
              set({
                contacts: get().contacts.map((c) =>
                  c.id === id ? { ...c, addressBookIds: { [addressBookId]: true } } : c,
                ),
              });
            } else {
              // Cross-account: create in the target account, then delete the source.
              const { id: _id, addressBookIds: _ab, uid: _uid, created: _c, updated: _u, ...data } = stripClientFields(contact);
              // A blobId names a photo in the source account and need not
              // resolve for the target one; send the bytes. If a download
              // fails the entry goes as it is: the create then either resolves
              // it or fails, and the source card is only deleted after a
              // successful create.
              const media = await inlineContactMedia(contact, 'keep');
              if (media) data.media = media;
              check();
              const created = tagCreated(await apiCreateContact(data, target.originalId, target.accountId), target.book);
              check();
              await apiDeleteContacts([source.originalId], source.accountId);
              set({ contacts: get().contacts.map((c) => (c.id === id ? created : c)) });
            }
          }
          requestDeviceSync(CONTACTS_AUTHORITY);
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
          const { check } = generationGuard();
          const book = await apiCreateAddressBook(trimmed);
          check();
          set({ addressBooks: [...get().addressBooks, book] });
          requestDeviceSync(CONTACTS_AUTHORITY);
          return book;
        },

        renameAddressBook: async (id, name) => {
          const trimmed = name.trim();
          if (!trimmed) return;
          const { check } = generationGuard();
          const { originalId, accountId } = bookTarget(id);
          await apiUpdateAddressBook(originalId, { name: trimmed }, accountId);
          check();
          set({
            addressBooks: get().addressBooks.map((b) => (b.id === id ? { ...b, name: trimmed } : b)),
          });
          requestDeviceSync(CONTACTS_AUTHORITY);
        },

        deleteAddressBook: async (id) => {
          const { check } = generationGuard();
          const { originalId, accountId } = bookTarget(id);
          // The confirmation names the cards that go with it.
          await apiDeleteAddressBook(originalId, accountId, { removeContents: true });
          check();
          // The server destroys the cards filed in the book along with it, so
          // drop them from the cache instead of leaving orphans under "All".
          set({
            addressBooks: get().addressBooks.filter((b) => b.id !== id),
            contacts: get().contacts.filter((c) => !c.addressBookIds?.[id]),
          });
          requestDeviceSync(CONTACTS_AUTHORITY);
          const category = get().selectedCategory;
          if (category.type === 'addressBook' && category.addressBookId === id) {
            get().setSelectedCategory({ type: 'all' });
          }
        },

        setDefaultAddressBook: async (id) => {
          const { check } = generationGuard();
          const { originalId, accountId, book } = bookTarget(id);
          await apiSetDefaultAddressBook(originalId, accountId);
          check();
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
          const { stale } = generationGuard();
          try {
            const recentRecipients = await queryRecentRecipients(mailboxId, 300);
            if (stale()) return;
            set({ recentRecipients, recentRecipientsLoaded: true });
          } catch (err) {
            console.warn('[contacts-store] load recent recipients failed', err);
            if (!stale()) set({ recentRecipientsLoaded: true });
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

        fetchDirectory: async () => {
          if (!jmapClient.isConnected) return;
          if (!supportsSharing()) {
            set({ directoryStatus: 'unavailable' });
            return;
          }
          if (directoryPromise) return directoryPromise;
          const { stale } = generationGuard();
          set({ directoryStatus: 'loading' });
          const promise: Promise<void> = (async () => {
            const listing = await listPrincipals();
            if (stale()) return;
            if (listing.status === 'error' && listing.principals.length === 0) {
              // Keep what an earlier load returned.
              set({ directoryStatus: 'error' });
              return;
            }
            set({
              directory: principalsToDirectory(listing.principals),
              directoryStatus: listing.status === 'restricted' ? 'restricted' : listing.status === 'error' ? 'error' : 'ready',
              directoryQueriesOff: !!listing.directoryQueriesOff,
            });
          })().finally(() => {
            if (directoryPromise === promise) directoryPromise = null;
          });
          directoryPromise = promise;
          return promise;
        },

        lookupDirectory: (query, limit = 10) =>
          normalizeSuggestions(directorySuggestions(get().directory, query, limit)),

        loadTrustedSendersBook: async (createIfMissing = false) => {
          if (!jmapClient.isConnected) return;
          // Share the in-flight load so parallel callers (mail view, settings,
          // addToTrustedSendersBook) never create the book twice - and so a
          // caller that needs the book id can wait for it instead of failing.
          if (trustedSendersPromise) await trustedSendersPromise;
          if (get().trustedSendersBookId) return;
          if (get().trustedSendersLoaded && !createIfMissing) return;

          set({ trustedSendersLoading: true });
          const { stale } = generationGuard();
          const promise: Promise<void> = (async () => {
            try {
              // Must throw rather than yield [] on failure: treating a failed
              // fetch as "no book yet" minted a duplicate on every hiccup (#730).
              const books = (await fetchPrimaryAddressBooks()) ?? [];
              // Sort so every client picks the same book when duplicates exist.
              const matches = books
                .filter((b) => b.name === TRUSTED_SENDERS_BOOK_NAME)
                .sort((a, b) => a.id.localeCompare(b.id));
              let book = matches[0];
              if (stale()) return;
              if (!book) {
                if (!createIfMissing) {
                  set({ trustedSendersLoaded: true, trustedSendersLoading: false });
                  return;
                }
                book = await apiCreateAddressBook(TRUSTED_SENDERS_BOOK_NAME);
                if (stale()) return;
              }
              const bookId = book.id;
              const cards = await getContactsInBook(bookId);
              if (stale()) return;
              set({
                trustedSendersBookId: bookId,
                trustedSenderEmails: collectContactEmails(cards),
                trustedSendersLoaded: true,
                trustedSendersLoading: false,
              });
            } catch (err) {
              console.warn('[contacts-store] load trusted senders failed', err);
              if (!stale()) set({ trustedSendersLoaded: true, trustedSendersLoading: false });
            }
          })().finally(() => {
            if (trustedSendersPromise === promise) trustedSendersPromise = null;
          });
          trustedSendersPromise = promise;
          return promise;
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

          const { check } = generationGuard();
          await apiCreateContact(
            {
              ...(name ? { name: { full: name } } : {}),
              emails: { email: { address: email } },
            },
            bookId,
          );
          check();
          set({ trustedSenderEmails: [...get().trustedSenderEmails, email] });
          requestDeviceSync(CONTACTS_AUTHORITY);
        },

        removeFromTrustedSendersBook: async (input) => {
          const { email } = parseTrustedSenderInput(input);
          const bookId = get().trustedSendersBookId;
          if (!bookId || !email) return;
          const { check } = generationGuard();
          const cards = await getContactsInBook(bookId);
          check();
          const matches = cards.filter((c) =>
            c.emails && Object.values(c.emails).some((e) => e.address?.toLowerCase().trim() === email));
          if (matches.length > 0) await apiDeleteContacts(matches.map((m) => m.id));
          check();
          set({ trustedSenderEmails: get().trustedSenderEmails.filter((e) => e !== email) });
          if (matches.length > 0) requestDeviceSync(CONTACTS_AUTHORITY);
        },

        isTrustedAddressBookSender: (email) =>
          get().trustedSenderEmails.includes(email.toLowerCase().trim()),

        setSelectedCategory: (category) => {
          set({ selectedCategory: category });
          persistCategory(category);
        },

        reset: () => {
          storeGeneration += 1;
          // The next account's first load must not join one still under way
          // for this one.
          addressBooksPromise = null;
          contactsPromise = null;
          trustedSendersPromise = null;
          directoryPromise = null;
          set({
            addressBooks: [],
            contacts: [],
            selectedCategory: { type: 'all' },
            loading: false,
            error: null,
            contactsFetchedAt: 0,
            trustedSendersBookId: null,
            trustedSenderEmails: [],
            trustedSendersLoaded: false,
            trustedSendersLoading: false,
            recentRecipients: [],
            recentRecipientsLoaded: false,
            sentMailboxId: null,
            directory: [],
            directoryStatus: 'idle',
            directoryQueriesOff: false,
          });
        },
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

/**
 * The address book a contact created from the list should go into: the one
 * being viewed (webmail 494adb9b), unless it is read-only. `undefined` lets
 * the form fall back to the default book.
 */
export function selectCreateTargetBookId(
  category: ContactCategory,
  addressBooks: AddressBook[],
): string | undefined {
  if (category.type !== 'addressBook') return undefined;
  const book = addressBooks.find((b) => b.id === category.addressBookId);
  return book && book.myRights?.mayWrite !== false ? book.id : undefined;
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

// One collator for every contact sort: `localeCompare` with options sets one
// up per comparison, which made a large address book slow to sort (PF10).
const contactNameCollator = new Intl.Collator(undefined, { sensitivity: 'base' });

/** Contact list order: by display name, or surname first with `byLastName` (#963). */
export function sortContactsByName(contacts: ContactCard[], byLastName: boolean): ContactCard[] {
  // Work out each sort name once instead of twice per comparison.
  const keyed = contacts.map((contact) => ({ contact, key: getContactSortName(contact, byLastName) }));
  keyed.sort((a, b) => contactNameCollator.compare(a.key, b.key));
  return keyed.map((entry) => entry.contact);
}
