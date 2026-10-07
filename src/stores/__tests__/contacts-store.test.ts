import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api/contacts', () => ({
  getAddressBooks: vi.fn(),
  getAllAddressBooks: vi.fn(),
  queryContacts: vi.fn(),
  getContacts: vi.fn(),
  getAllContacts: vi.fn(),
  createContact: vi.fn(),
  updateContact: vi.fn(),
  deleteContacts: vi.fn(),
  createAddressBook: vi.fn(),
  updateAddressBook: vi.fn(),
  deleteAddressBook: vi.fn(),
  setDefaultAddressBook: vi.fn(),
  setAddressBookShare: vi.fn(),
  getContactsInBook: vi.fn(),
  getContactsAccountId: () => 'acc-1',
  getContactCapableAccountIds: () => ['acc-1', 'acc-team'],
  namespaceId: (accountId: string, id: string) => `${accountId}:${id}`,
  stripClientFields: (c: Record<string, unknown>) => {
    const { originalId: _o, accountId: _a, accountName: _n, isShared: _s, ...rest } = c;
    return rest;
  },
}));

// The app account the app shows; the store's account checks read it.
const shown = vi.hoisted(() => ({ app: 'app-1' as string | null }));
vi.mock('../email-store', () => ({
  requireShownAccountScope: (appAccountId: string | null, jmapAccountId?: string) => {
    if (!appAccountId || appAccountId !== shown.app) throw new Error('This belongs to another account.');
    return { gen: 5, accountId: jmapAccountId ?? 'acc-1' };
  },
  isShownAccount: (appAccountId: string | null) => !!appAccountId && appAccountId === shown.app,
}));

vi.mock('../../api/recent-recipients', () => ({
  queryRecentRecipients: vi.fn(),
  searchSentRecipients: vi.fn(),
}));

vi.mock('../../api/principals', () => ({
  getPrincipals: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

const client = vi.hoisted(() => ({
  accountId: 'acc-1', isConnected: true, username: 'u1', serverUrl: 'https://a.example',
}));
const accounts = vi.hoisted(() => ({ active: 'app-1' }));
vi.mock('../../api/jmap-client', () => ({ jmapClient: client }));
vi.mock('../account-store', () => ({
  useAccountStore: {
    getState: () => ({
      activeAccountId: accounts.active,
      getAccountById: (id: string) =>
        ({ 'app-1': { username: 'u1', serverUrl: 'https://a.example/' }, 'app-2': { username: 'u2', serverUrl: 'https://b.example' } } as Record<string, unknown>)[id],
    }),
  },
}));

import * as contactsApi from '../../api/contacts';
import * as recentApi from '../../api/recent-recipients';
import * as principalsApi from '../../api/principals';
import {
  useContactsStore,
  cleanGroupMembers,
  normalizeSuggestions,
  mergeServerHits,
  selectVisibleContacts,
  selectGroupMembers,
  sortContactsByName,
  selectCreateTargetBookId,
  CONTACTS_STALE_MS,
} from '../contacts-store';
import type { AddressBook, ContactCard } from '../../api/types';

const mockGetAddressBooks = contactsApi.getAddressBooks as ReturnType<typeof vi.fn>;
const mockGetAllAddressBooks = contactsApi.getAllAddressBooks as ReturnType<typeof vi.fn>;
const mockQueryContacts = contactsApi.queryContacts as ReturnType<typeof vi.fn>;
const mockGetContacts = contactsApi.getContacts as ReturnType<typeof vi.fn>;
const mockGetAllContacts = contactsApi.getAllContacts as ReturnType<typeof vi.fn>;
const mockCreateContact = contactsApi.createContact as ReturnType<typeof vi.fn>;
const mockUpdateContact = contactsApi.updateContact as ReturnType<typeof vi.fn>;
const mockDeleteContacts = contactsApi.deleteContacts as ReturnType<typeof vi.fn>;
const mockCreateAddressBook = contactsApi.createAddressBook as ReturnType<typeof vi.fn>;
const mockDeleteAddressBook = contactsApi.deleteAddressBook as ReturnType<typeof vi.fn>;
const mockSetDefaultAddressBook = contactsApi.setDefaultAddressBook as ReturnType<typeof vi.fn>;
const mockSetAddressBookShare = contactsApi.setAddressBookShare as ReturnType<typeof vi.fn>;
const mockGetContactsInBook = contactsApi.getContactsInBook as ReturnType<typeof vi.fn>;
const mockGetPrincipals = principalsApi.getPrincipals as ReturnType<typeof vi.fn>;
const mockSearchSent = recentApi.searchSentRecipients as ReturnType<typeof vi.fn>;
const mockQueryRecent = recentApi.queryRecentRecipients as ReturnType<typeof vi.fn>;

const card = (id: string, extra: Partial<ContactCard> = {}): ContactCard =>
  ({ id, addressBookIds: { 'ab-1': true }, ...extra }) as ContactCard;

beforeEach(() => {
  vi.clearAllMocks();
  shown.app = 'app-1';
  useContactsStore.getState().reset();
});

describe('contacts-store', () => {
  describe('fetchAddressBooks', () => {
    it('should load address books from every contacts-capable account', async () => {
      const books = [{ id: 'ab-1', name: 'Personal' }, { id: 'acc-team:ab', name: 'Team', isShared: true }];
      mockGetAllAddressBooks.mockResolvedValue(books);

      await useContactsStore.getState().fetchAddressBooks();

      expect(useContactsStore.getState().addressBooks).toEqual(books);
    });

    it('shares one in-flight request between concurrent callers', async () => {
      let resolve: (v: unknown) => void = () => {};
      mockGetAllAddressBooks.mockReturnValue(new Promise((r) => { resolve = r; }));
      const a = useContactsStore.getState().fetchAddressBooks();
      const b = useContactsStore.getState().fetchAddressBooks();
      resolve([{ id: 'ab-1', name: 'P' }]);
      await Promise.all([a, b]);
      expect(mockGetAllAddressBooks).toHaveBeenCalledTimes(1);
      expect(useContactsStore.getState().addressBooks).toHaveLength(1);
    });
  });

  describe('fetchContacts', () => {
    it('should query and fetch contacts with a filter', async () => {
      mockQueryContacts.mockResolvedValue(['c1', 'c2']);
      const contacts = [{ id: 'c1' }, { id: 'c2' }];
      mockGetContacts.mockResolvedValue(contacts);

      await useContactsStore.getState().fetchContacts({ text: 'john' });

      expect(useContactsStore.getState().contacts).toEqual(contacts);
      expect(useContactsStore.getState().loading).toBe(false);
    });

    it('should handle empty results', async () => {
      mockQueryContacts.mockResolvedValue([]);

      await useContactsStore.getState().fetchContacts({ text: 'nobody' });

      expect(useContactsStore.getState().contacts).toEqual([]);
      expect(mockGetContacts).not.toHaveBeenCalled();
    });

    it('loads every account without a filter', async () => {
      mockGetAllContacts.mockResolvedValue([{ id: 'c1' }, { id: 'acc-team:c2', isShared: true }]);
      await useContactsStore.getState().fetchContacts();
      expect(useContactsStore.getState().contacts).toHaveLength(2);
    });

    it('waits for an in-flight address book load before querying', async () => {
      const order: string[] = [];
      let resolveBooks: (v: unknown) => void = () => {};
      mockGetAllAddressBooks.mockReturnValue(new Promise((r) => { resolveBooks = r; }));
      mockGetAllContacts.mockImplementation(async () => { order.push('contacts'); return []; });

      const books = useContactsStore.getState().fetchAddressBooks();
      const contacts = useContactsStore.getState().fetchContacts();
      expect(order).toEqual([]);
      order.push('books-resolved');
      resolveBooks([]);
      await Promise.all([books, contacts]);
      expect(order).toEqual(['books-resolved', 'contacts']);
    });
  });

  describe('fetchContactsIfStale (PF6)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('does not download the cards again while the last full fetch is fresh', async () => {
      vi.useFakeTimers();
      mockGetAllContacts.mockResolvedValue([card('c1')]);
      await useContactsStore.getState().fetchContacts();
      expect(mockGetAllContacts).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(CONTACTS_STALE_MS - 1000);
      await useContactsStore.getState().fetchContactsIfStale();
      expect(mockGetAllContacts).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(2000);
      await useContactsStore.getState().fetchContactsIfStale();
      expect(mockGetAllContacts).toHaveBeenCalledTimes(2);
    });

    it('fetches when nothing was loaded this session, after a reset or after a filtered load', async () => {
      mockGetAllContacts.mockResolvedValue([card('c1')]);
      await useContactsStore.getState().fetchContactsIfStale();
      expect(mockGetAllContacts).toHaveBeenCalledTimes(1);

      useContactsStore.getState().reset();
      await useContactsStore.getState().fetchContactsIfStale();
      expect(mockGetAllContacts).toHaveBeenCalledTimes(2);

      mockQueryContacts.mockResolvedValue([]);
      await useContactsStore.getState().fetchContacts({ text: 'x' });
      await useContactsStore.getState().fetchContactsIfStale();
      expect(mockGetAllContacts).toHaveBeenCalledTimes(3);
    });

    it('retries on the next open when the last fetch failed', async () => {
      mockGetAllContacts.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([card('c1')]);
      await useContactsStore.getState().fetchContactsIfStale();
      expect(useContactsStore.getState().contactsFetchedAt).toBe(0);
      await useContactsStore.getState().fetchContactsIfStale();
      expect(mockGetAllContacts).toHaveBeenCalledTimes(2);
      expect(useContactsStore.getState().contacts).toHaveLength(1);
    });
  });

  describe('createContact', () => {
    it('should create and append to list', async () => {
      useContactsStore.setState({ contacts: [card('c1')], addressBooks: [{ id: 'ab-1', name: 'P' }] });
      const created = { id: 'c-new', addressBookIds: { 'ab-1': true } };
      mockCreateContact.mockResolvedValue(created);

      const result = await useContactsStore.getState().createContact({}, 'ab-1');

      expect(result).toEqual(created);
      expect(mockCreateContact).toHaveBeenCalledWith({}, 'ab-1', undefined);
      expect(useContactsStore.getState().contacts).toHaveLength(2);
    });

    it('binds the write to the scope the caller took, and keeps the card out of the next account\'s list', async () => {
      useContactsStore.setState({ contacts: [card('c1')], addressBooks: [{ id: 'ab-1', name: 'P' }] });
      mockCreateContact.mockImplementationOnce(async () => {
        useContactsStore.getState().reset();
        return { id: 'c-new', addressBookIds: { 'ab-1': true } };
      });
      const result = await useContactsStore.getState().createContact({}, 'ab-1', { gen: 3, accountId: 'acc-1' });
      expect(mockCreateContact).toHaveBeenCalledWith({}, 'ab-1', undefined, { gen: 3 });
      expect(result.id).toBe('c-new');
      expect(useContactsStore.getState().contacts).toEqual([]);
    });

    it('routes a shared book to its account and namespaces the result', async () => {
      useContactsStore.setState({
        addressBooks: [
          { id: 'ab-1', name: 'P' },
          { id: 'acc-team:ab', originalId: 'ab', name: 'Team', accountId: 'acc-team', accountName: 'Team', isShared: true },
        ],
      });
      mockCreateContact.mockResolvedValue({ id: 'c9', addressBookIds: { ab: true } });

      const result = await useContactsStore.getState().createContact({ name: { full: 'X' } }, 'acc-team:ab');

      expect(mockCreateContact).toHaveBeenCalledWith({ name: { full: 'X' } }, 'ab', 'acc-team');
      expect(result).toMatchObject({
        id: 'acc-team:c9', originalId: 'c9', accountId: 'acc-team', isShared: true, addressBookIds: { 'acc-team:ab': true },
      });
    });
  });

  describe('updateContact', () => {
    it('should update and merge changes in state', async () => {
      useContactsStore.setState({ contacts: [card('c1', { kind: 'individual' })] });
      mockUpdateContact.mockResolvedValue(undefined);

      await useContactsStore.getState().updateContact('c1', { kind: 'org' });

      expect(useContactsStore.getState().contacts[0].kind).toBe('org');
      expect(mockUpdateContact).toHaveBeenCalledWith('c1', { kind: 'org' }, undefined);
    });

    it('drops properties patched to null locally', async () => {
      useContactsStore.setState({ contacts: [card('c1', { phones: { p1: { number: '1' } } })] });
      mockUpdateContact.mockResolvedValue(undefined);
      await useContactsStore.getState().updateContact('c1', { phones: null } as never);
      expect(useContactsStore.getState().contacts[0].phones).toBeUndefined();
    });

    it('does not apply changes the server refused', async () => {
      useContactsStore.setState({ contacts: [card('c1', { kind: 'individual' })] });
      mockUpdateContact.mockRejectedValue(new Error('read-only'));
      await expect(useContactsStore.getState().updateContact('c1', { kind: 'org' })).rejects.toThrow('read-only');
      expect(useContactsStore.getState().contacts[0].kind).toBe('individual');
    });

    it('de-namespaces book ids and routes shared cards to their account', async () => {
      useContactsStore.setState({
        contacts: [card('acc-team:c1', { originalId: 'c1', accountId: 'acc-team', isShared: true })],
      });
      mockUpdateContact.mockResolvedValue(undefined);
      await useContactsStore.getState().updateContact('acc-team:c1', { addressBookIds: { 'acc-team:ab': true } });
      expect(mockUpdateContact).toHaveBeenCalledWith('c1', { addressBookIds: { ab: true } }, 'acc-team');
    });

    it('binds the write to the scope the caller took', async () => {
      useContactsStore.setState({ contacts: [card('c1')] });
      mockUpdateContact.mockResolvedValue(undefined);
      await useContactsStore.getState().updateContact('c1', { kind: 'org' }, { gen: 7, accountId: 'acc-1' });
      expect(mockUpdateContact).toHaveBeenCalledWith('c1', { kind: 'org' }, undefined, { gen: 7 });
    });

    it('does not merge into the next account\'s card with the same id after a switch', async () => {
      useContactsStore.setState({ contacts: [card('c1', { kind: 'individual' })] });
      mockUpdateContact.mockImplementationOnce(async () => {
        // The switch lands while the write is out: the new account has a "c1" too.
        useContactsStore.getState().reset();
        useContactsStore.setState({ contacts: [card('c1', { kind: 'individual' })] });
      });
      await useContactsStore.getState().updateContact('c1', { kind: 'org' });
      expect(useContactsStore.getState().contacts[0].kind).toBe('individual');
    });
  });

  describe('deleteContact', () => {
    it('should remove from list and clean group members', async () => {
      useContactsStore.setState({
        contacts: [
          card('c1', { uid: 'urn:uuid:u1' }),
          card('c2'),
          card('g1', { kind: 'group', members: { u1: true, c2: true } }),
        ],
      });
      mockDeleteContacts.mockResolvedValue(['c1']);

      await useContactsStore.getState().deleteContact('c1');

      const contacts = useContactsStore.getState().contacts;
      expect(contacts.map((c) => c.id)).toEqual(['c2', 'g1']);
      expect(contacts[1].members).toEqual({ c2: true });
    });
  });

  describe('bulkDelete', () => {
    it('only drops the ids the server destroyed', async () => {
      useContactsStore.setState({ contacts: [card('c1'), card('c2'), card('c3')] });
      mockDeleteContacts.mockResolvedValue(['c1', 'c3']);

      await useContactsStore.getState().bulkDelete(['c1', 'c2', 'c3']);

      expect(useContactsStore.getState().contacts.map((c) => c.id)).toEqual(['c2']);
      expect(useContactsStore.getState().error).toMatch(/1 contact/);
    });

    it('groups cards by account', async () => {
      useContactsStore.setState({
        contacts: [card('c1'), card('acc-team:c2', { originalId: 'c2', accountId: 'acc-team', isShared: true })],
      });
      mockDeleteContacts.mockImplementation(async (ids: string[]) => ids);
      await useContactsStore.getState().bulkDelete(['c1', 'acc-team:c2']);
      expect(mockDeleteContacts).toHaveBeenCalledWith(['c1'], undefined);
      expect(mockDeleteContacts).toHaveBeenCalledWith(['c2'], 'acc-team');
      expect(useContactsStore.getState().contacts).toEqual([]);
    });
  });

  describe('importContacts', () => {
    it('reports imported and failed counts', async () => {
      useContactsStore.setState({ addressBooks: [{ id: 'ab-1', name: 'P' }] });
      mockCreateContact
        .mockResolvedValueOnce({ id: 'n1', addressBookIds: { 'ab-1': true } })
        .mockRejectedValueOnce(new Error('invalid'));
      const result = await useContactsStore.getState().importContacts(
        [{ id: 'import-1', name: { full: 'A' } }, { id: 'import-2', name: { full: 'B' } }],
        'ab-1',
      );
      expect(result).toEqual({ imported: 1, failed: 1 });
      expect(useContactsStore.getState().contacts).toHaveLength(1);
    });
  });

  describe('address books', () => {
    it('deleting a book drops its cards from the cache', async () => {
      useContactsStore.setState({
        addressBooks: [{ id: 'ab-1', name: 'P' }, { id: 'ab-2', name: 'Q' }],
        contacts: [card('c1'), card('c2', { addressBookIds: { 'ab-2': true } })],
      });
      mockDeleteAddressBook.mockResolvedValue(undefined);
      await useContactsStore.getState().deleteAddressBook('ab-2');
      expect(useContactsStore.getState().addressBooks.map((b) => b.id)).toEqual(['ab-1']);
      expect(useContactsStore.getState().contacts.map((c) => c.id)).toEqual(['c1']);
    });

    it('setDefaultAddressBook flips the flag on siblings', async () => {
      useContactsStore.setState({
        addressBooks: [{ id: 'ab-1', name: 'P', isDefault: true }, { id: 'ab-2', name: 'Q' }],
      });
      mockSetDefaultAddressBook.mockResolvedValue(undefined);
      await useContactsStore.getState().setDefaultAddressBook('ab-2');
      expect(mockSetDefaultAddressBook).toHaveBeenCalledWith('ab-2', undefined);
      expect(useContactsStore.getState().addressBooks.map((b) => !!b.isDefault)).toEqual([false, true]);
    });

    it('getDefaultAddressBookId prefers the default own book', () => {
      useContactsStore.setState({
        addressBooks: [
          { id: 'acc-team:ab', name: 'Team', isShared: true, isDefault: true },
          { id: 'ab-1', name: 'P' },
          { id: 'ab-2', name: 'Q', isDefault: true },
        ],
      });
      expect(useContactsStore.getState().getDefaultAddressBookId()).toBe('ab-2');
    });
  });

  describe('shareAddressBook', () => {
    const owner = { appAccountId: 'app-1' };
    const read = { mayRead: true, mayWrite: false, mayShare: false, mayDelete: false };

    it('shares on the owner\'s connection and records the grant', async () => {
      useContactsStore.setState({ addressBooks: [{ id: 'ab-1', name: 'P', shareWith: { 'p-1': read } }] });
      mockSetAddressBookShare.mockResolvedValue(undefined);

      await useContactsStore.getState().shareAddressBook('ab-1', 'p-2', read, owner);

      expect(mockSetAddressBookShare).toHaveBeenCalledWith('ab-1', 'p-2', read, { gen: 5, accountId: 'acc-1' });
      expect(useContactsStore.getState().addressBooks[0].shareWith).toEqual({ 'p-1': read, 'p-2': read });
    });

    it('drops the grant on a revoke', async () => {
      useContactsStore.setState({ addressBooks: [{ id: 'ab-1', name: 'P', shareWith: { 'p-1': read, 'p-2': read } }] });
      mockSetAddressBookShare.mockResolvedValue(undefined);

      await useContactsStore.getState().shareAddressBook('ab-1', 'p-1', null, owner);

      expect(mockSetAddressBookShare).toHaveBeenCalledWith('ab-1', 'p-1', null, { gen: 5, accountId: 'acc-1' });
      expect(useContactsStore.getState().addressBooks[0].shareWith).toEqual({ 'p-2': read });
    });

    it('is refused while another account is shown', async () => {
      useContactsStore.setState({ addressBooks: [{ id: 'ab-1', name: 'P' }] });
      shown.app = 'app-2';

      await expect(useContactsStore.getState().shareAddressBook('ab-1', 'p-2', read, owner)).rejects.toThrow();
      expect(mockSetAddressBookShare).not.toHaveBeenCalled();
    });

    it('writes nothing locally when the account switched while the share was out', async () => {
      useContactsStore.setState({ addressBooks: [{ id: 'ab-1', name: 'P' }] });
      mockSetAddressBookShare.mockImplementationOnce(async () => {
        // The next account has an "ab-1" too.
        shown.app = 'app-2';
        useContactsStore.getState().reset();
        useContactsStore.setState({ addressBooks: [{ id: 'ab-1', name: 'Other' }] });
      });

      await useContactsStore.getState().shareAddressBook('ab-1', 'p-2', read, owner);

      expect(useContactsStore.getState().addressBooks).toEqual([{ id: 'ab-1', name: 'Other' }]);
    });

    it('refuses a book shared with the user', async () => {
      useContactsStore.setState({
        addressBooks: [{ id: 'acc-team:ab', originalId: 'ab', accountId: 'acc-team', name: 'Team', isShared: true }],
      });

      await expect(useContactsStore.getState().shareAddressBook('acc-team:ab', 'p-2', read, owner)).rejects.toThrow();
      expect(mockSetAddressBookShare).not.toHaveBeenCalled();
    });
  });

  describe('groups', () => {
    it('addContactsToGroup references members by uid', async () => {
      useContactsStore.setState({
        contacts: [
          card('g1', { kind: 'group', members: { existing: true } }),
          card('c1', { uid: 'urn:uuid:u1' }),
          card('c2'),
        ],
      });
      mockUpdateContact.mockResolvedValue(undefined);
      await useContactsStore.getState().addContactsToGroup('g1', ['c1', 'c2']);
      expect(mockUpdateContact).toHaveBeenCalledWith(
        'g1', { members: { existing: true, 'urn:uuid:u1': true, c2: true } }, undefined,
      );
    });

    it('createGroup creates a kind=group card in the default book', async () => {
      useContactsStore.setState({
        addressBooks: [{ id: 'ab-1', name: 'P', isDefault: true }],
        contacts: [card('c1', { uid: 'u1' })],
      });
      mockCreateContact.mockResolvedValue({ id: 'g1', kind: 'group', addressBookIds: { 'ab-1': true } });
      await useContactsStore.getState().createGroup('Sales', ['c1']);
      expect(mockCreateContact).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'group', members: { u1: true }, name: expect.objectContaining({ full: 'Sales' }) }),
        'ab-1',
        undefined,
      );
    });

    it('getGroupRecipients dedupes addresses case-insensitively', () => {
      useContactsStore.setState({
        contacts: [
          card('g1', { kind: 'group', members: { c1: true, c2: true, c3: true } }),
          card('c1', { name: { full: 'A' }, emails: { e: { address: 'a@x.com' } } }),
          card('c2', { name: { full: 'A2' }, emails: { e: { address: 'A@X.COM' } } }),
          card('c3', { name: { full: 'B <b@x.com>' }, emails: { e: { address: 'b@x.com' } } }),
        ],
      });
      expect(useContactsStore.getState().getGroupRecipients('g1')).toEqual([
        { name: 'A', email: 'a@x.com' },
        { name: 'B', email: 'b@x.com' },
      ]);
    });
  });

  describe('renameKeyword', () => {
    it('rewrites the keyword on every affected card', async () => {
      useContactsStore.setState({
        contacts: [card('c1', { keywords: { Old: true, Keep: true } }), card('c2', { keywords: { Other: true } })],
        selectedCategory: { type: 'keyword', keyword: 'Old' },
      });
      mockUpdateContact.mockResolvedValue(undefined);
      await useContactsStore.getState().renameKeyword('Old', 'New');
      expect(mockUpdateContact).toHaveBeenCalledTimes(1);
      expect(mockUpdateContact).toHaveBeenCalledWith('c1', { keywords: { Keep: true, New: true } }, undefined);
      expect(useContactsStore.getState().selectedCategory).toEqual({ type: 'keyword', keyword: 'New' });
    });
  });

  describe('directory people', () => {
    const dana = { id: 'p1', type: 'individual', name: 'dana', description: 'Dana Director', email: 'dana@example.com' };

    it('should augment results with directory principals', async () => {
      mockGetPrincipals.mockResolvedValue([dana]);
      await useContactsStore.getState().loadDirectory();
      expect(useContactsStore.getState().getAutocomplete('dana')).toEqual([
        { name: 'Dana Director', email: 'dana@example.com' },
      ]);
    });

    it('matches on description and drops principals without an email', async () => {
      mockGetPrincipals.mockResolvedValue([dana, { id: 'p2', type: 'group', name: 'staff', email: null }]);
      await useContactsStore.getState().loadDirectory();
      expect(useContactsStore.getState().getAutocomplete('director')).toHaveLength(1);
      expect(useContactsStore.getState().getAutocomplete('staff')).toEqual([]);
    });

    it('should not duplicate a directory principal already matched as a contact', async () => {
      useContactsStore.setState({
        contacts: [card('c1', { name: { full: 'Jane' }, emails: { e: { address: 'jane@example.com' } } })],
      });
      mockGetPrincipals.mockResolvedValue([
        { id: 'p3', type: 'individual', name: 'Jane From Directory', email: 'JANE@example.com' },
      ]);
      await useContactsStore.getState().loadDirectory();
      const results = useContactsStore.getState().getAutocomplete('jane');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Jane');
    });

    it('lets a nameless contact borrow the directory name', async () => {
      useContactsStore.setState({
        contacts: [card('c1', { emails: { e: { address: 'dana@example.com' } } })],
      });
      mockGetPrincipals.mockResolvedValue([dana]);
      await useContactsStore.getState().loadDirectory();
      expect(useContactsStore.getState().getAutocomplete('dana@')).toEqual([
        { name: 'Dana Director', email: 'dana@example.com' },
      ]);
    });

    it('sits after contacts and before recent recipients', async () => {
      useContactsStore.setState({
        contacts: [card('c1', { name: { full: 'Dan Contact' }, emails: { e: { address: 'dan@x.com' } } })],
      });
      mockQueryRecent.mockResolvedValue([{ name: 'Dan Recent', email: 'danr@x.com' }]);
      await useContactsStore.getState().loadRecentRecipients('sent-1');
      mockGetPrincipals.mockResolvedValue([{ id: 'p', type: 'individual', name: 'Dan Dir', email: 'dand@x.com' }]);
      await useContactsStore.getState().loadDirectory();
      expect(useContactsStore.getState().getAutocomplete('dan').map((r) => r.email))
        .toEqual(['dan@x.com', 'dand@x.com', 'danr@x.com']);
    });

    it('loads once per account', async () => {
      mockGetPrincipals.mockResolvedValue([dana]);
      await useContactsStore.getState().loadDirectory();
      await useContactsStore.getState().loadDirectory();
      expect(mockGetPrincipals).toHaveBeenCalledTimes(1);
    });

    it('a caller during a load waits for that load instead of returning at once', async () => {
      let release!: (v: unknown[]) => void;
      mockGetPrincipals.mockReturnValue(new Promise((r) => { release = r; }));
      const first = useContactsStore.getState().loadDirectory();
      let secondDone = false;
      const second = useContactsStore.getState().loadDirectory().then(() => { secondDone = true; });
      await Promise.resolve();
      await Promise.resolve();
      expect(secondDone).toBe(false);
      release([dana]);
      await Promise.all([first, second]);
      expect(mockGetPrincipals).toHaveBeenCalledTimes(1);
      expect(useContactsStore.getState().directoryPeople).toHaveLength(1);
    });

    it('a failed load leaves no directory people and does not throw', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockGetPrincipals.mockRejectedValue(new Error('boom'));
      await expect(useContactsStore.getState().loadDirectory()).resolves.toBeUndefined();
      expect(useContactsStore.getState().getAutocomplete('dana')).toEqual([]);
      warn.mockRestore();
    });

    it('retries a failed load on the next call', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockGetPrincipals.mockRejectedValueOnce(new Error('boom'));
      await useContactsStore.getState().loadDirectory();
      mockGetPrincipals.mockResolvedValue([dana]);
      await useContactsStore.getState().loadDirectory();
      expect(mockGetPrincipals).toHaveBeenCalledTimes(2);
      expect(useContactsStore.getState().getAutocomplete('dana')).toHaveLength(1);
      warn.mockRestore();
    });

    it('reset drops the directory, and a load in flight across a reset is discarded', async () => {
      mockGetPrincipals.mockResolvedValue([dana]);
      await useContactsStore.getState().loadDirectory();
      useContactsStore.getState().reset();
      expect(useContactsStore.getState().getAutocomplete('dana')).toEqual([]);

      let release!: (v: unknown[]) => void;
      mockGetPrincipals.mockReturnValue(new Promise((r) => { release = r; }));
      const pending = useContactsStore.getState().loadDirectory();
      useContactsStore.getState().reset();
      release([dana]);
      await pending;
      expect(useContactsStore.getState().getAutocomplete('dana')).toEqual([]);
    });
  });

  describe('directory across an account switch', () => {
    const dana = { id: 'p1', type: 'individual', name: 'dana', description: 'Dana Director', email: 'dana@example.com' };
    const toSecond = () => {
      accounts.active = 'app-2';
      client.username = 'u2'; client.serverUrl = 'https://b.example';
    };
    afterEach(() => {
      accounts.active = 'app-1'; client.username = 'u1'; client.serverUrl = 'https://a.example';
      client.accountId = 'acc-1';
    });

    it('does not load for a client still on the account being left', async () => {
      useContactsStore.getState().reset();
      accounts.active = 'app-2'; // account store ahead of the client
      mockGetPrincipals.mockResolvedValue([dana]);
      await useContactsStore.getState().loadDirectory();
      expect(mockGetPrincipals).not.toHaveBeenCalled();
      expect(useContactsStore.getState().getAutocomplete('dana')).toEqual([]);
      // once the client catches up it loads for the new account
      client.username = 'u2'; client.serverUrl = 'https://b.example'; client.accountId = 'acc-2';
      await useContactsStore.getState().loadDirectory();
      expect(useContactsStore.getState().getAutocomplete('dana')).toHaveLength(1);
    });

    it('discards a load that resolves after the client moved on, even to the same JMAP id', async () => {
      let release!: (v: unknown[]) => void;
      mockGetPrincipals.mockReturnValue(new Promise((r) => { release = r; }));
      const pending = useContactsStore.getState().loadDirectory();
      toSecond(); // same JMAP account id "acc-1" on another server
      release([dana]);
      await pending;
      expect(useContactsStore.getState().directoryPeople).toEqual([]);
      expect(useContactsStore.getState().getAutocomplete('dana')).toEqual([]);
    });

    it('ignores directory people of another account in getAutocomplete', async () => {
      mockGetPrincipals.mockResolvedValue([dana]);
      await useContactsStore.getState().loadDirectory();
      expect(useContactsStore.getState().getAutocomplete('dana')).toHaveLength(1);
      client.accountId = 'acc-2';
      expect(useContactsStore.getState().getAutocomplete('dana')).toEqual([]);
      client.accountId = 'acc-1';
      toSecond();
      expect(useContactsStore.getState().getAutocomplete('dana')).toEqual([]);
    });
  });

  describe('server recipient search', () => {
    it('searchRecipients queries the Sent folder for the query', async () => {
      useContactsStore.setState({ sentMailboxId: 'sent-1' });
      mockSearchSent.mockResolvedValue([{ name: 'Zed', email: 'zed@x.com' }]);
      expect(await useContactsStore.getState().searchRecipients(' zed ')).toEqual([{ name: 'Zed', email: 'zed@x.com' }]);
      expect(mockSearchSent).toHaveBeenCalledWith('zed', 'sent-1');
    });
  });

  describe('mergeServerHits', () => {
    it('appends new hits, deduped by email and skipping already-selected', () => {
      const shown = [{ name: 'A', email: 'a@x.com' }];
      const hits = [
        { name: 'A again', email: 'A@x.com' },
        { name: 'B', email: 'b@x.com' },
        { name: 'C', email: 'c@x.com' },
      ];
      expect(mergeServerHits(shown, hits, new Set(['c@x.com']))).toEqual([
        { name: 'A', email: 'a@x.com' },
        { name: 'B', email: 'b@x.com' },
      ]);
    });
  });

  describe('autocomplete', () => {
    it('merges contacts, groups and recent recipients without duplicates', async () => {
      useContactsStore.setState({
        contacts: [
          card('c1', { name: { full: 'Jane Doe' }, emails: { e: { address: 'jane@x.com' } } }),
          card('g1', { kind: 'group', name: { full: 'Jane fans' }, members: { c1: true } }),
        ],
      });
      mockQueryRecent.mockResolvedValue([
        { name: 'Jane Doe', email: 'JANE@x.com' },
        { name: 'Janet', email: 'janet@x.com' },
      ]);
      await useContactsStore.getState().loadRecentRecipients('sent-1');
      expect(mockQueryRecent).toHaveBeenCalledWith('sent-1', 300);

      const results = useContactsStore.getState().getAutocomplete('jan');
      expect(results).toEqual([
        { name: 'Jane Doe', email: 'jane@x.com' },
        { name: 'Jane fans', email: '', group: { id: 'g1', memberCount: 1 } },
        { name: 'Janet', email: 'janet@x.com' },
      ]);
    });

    it('loadRecentRecipients is a no-op once loaded', async () => {
      mockQueryRecent.mockResolvedValue([]);
      await useContactsStore.getState().loadRecentRecipients('sent-1');
      await useContactsStore.getState().loadRecentRecipients('sent-1');
      expect(mockQueryRecent).toHaveBeenCalledTimes(1);
    });

    it('findContactByEmail matches case-insensitively and accepts a mailbox', () => {
      useContactsStore.setState({
        contacts: [card('c1', { emails: { e: { address: 'Jane@X.com' } } })],
      });
      expect(useContactsStore.getState().findContactByEmail('jane@x.com')?.id).toBe('c1');
      expect(useContactsStore.getState().findContactByEmail('Jane <JANE@x.com>')?.id).toBe('c1');
      expect(useContactsStore.getState().findContactByEmail('nobody@x.com')).toBeUndefined();
    });
  });

  describe('trusted senders', () => {
    it('add-after-load waits for the in-flight passive load', async () => {
      let resolveBooks: (v: unknown) => void = () => {};
      mockGetAddressBooks.mockReturnValue(new Promise((r) => { resolveBooks = r; }));
      mockGetContactsInBook.mockResolvedValue([]);
      mockCreateContact.mockResolvedValue({ id: 't1' });

      const passive = useContactsStore.getState().loadTrustedSendersBook();
      const add = useContactsStore.getState().addToTrustedSendersBook('Jane <Jane@X.com>');
      resolveBooks([{ id: 'ab-ts-b', name: 'Trusted Senders' }, { id: 'ab-ts-a', name: 'Trusted Senders' }]);
      await Promise.all([passive, add]);

      expect(mockGetAddressBooks).toHaveBeenCalledTimes(1);
      // Duplicate books: the lowest id wins on every client (#730).
      expect(useContactsStore.getState().trustedSendersBookId).toBe('ab-ts-a');
      expect(mockCreateContact).toHaveBeenCalledWith(
        { name: { full: 'Jane' }, emails: { email: { address: 'jane@x.com' } } },
        'ab-ts-a',
      );
      expect(useContactsStore.getState().trustedSenderEmails).toEqual(['jane@x.com']);
    });

    it('creates the book on first add when the passive load found none', async () => {
      mockGetAddressBooks.mockResolvedValue([]);
      mockCreateAddressBook.mockResolvedValue({ id: 'ab-new', name: 'Trusted Senders' });
      mockGetContactsInBook.mockResolvedValue([]);
      mockCreateContact.mockResolvedValue({ id: 't1' });

      await useContactsStore.getState().loadTrustedSendersBook();
      expect(useContactsStore.getState().trustedSendersBookId).toBeNull();
      expect(mockCreateAddressBook).not.toHaveBeenCalled();

      await useContactsStore.getState().addToTrustedSendersBook('x@y.com');
      expect(mockCreateAddressBook).toHaveBeenCalledWith('Trusted Senders');
      expect(useContactsStore.getState().trustedSendersBookId).toBe('ab-new');
    });

    it('removeFromTrustedSendersBook deletes the matching card', async () => {
      useContactsStore.setState({ trustedSendersBookId: 'ab-ts', trustedSenderEmails: ['x@y.com', 'z@y.com'] });
      mockGetContactsInBook.mockResolvedValue([
        card('t1', { emails: { e: { address: 'X@y.com' } } }),
        card('t2', { emails: { e: { address: 'z@y.com' } } }),
      ]);
      mockDeleteContacts.mockResolvedValue(['t1']);
      await useContactsStore.getState().removeFromTrustedSendersBook('Someone <x@y.com>');
      expect(mockDeleteContacts).toHaveBeenCalledWith(['t1']);
      expect(useContactsStore.getState().trustedSenderEmails).toEqual(['z@y.com']);
    });
  });
});

describe('persistence', () => {
  it('hands the storage the same slice while the cards are unchanged', () => {
    const partialize = useContactsStore.persist.getOptions().partialize!;
    useContactsStore.setState({ contacts: [card('c1', { media: { p: { kind: 'photo' } } } as never)] });

    const slice = partialize(useContactsStore.getState()) as { contacts: ContactCard[] };
    expect(slice.contacts[0]).not.toHaveProperty('media');
    expect(partialize({ ...useContactsStore.getState(), loading: true })).toBe(slice);
  });
});

describe('helpers', () => {
  it('cleanGroupMembers strips id, uid and urn:uuid variants', () => {
    const contacts = [
      card('c1', { uid: 'urn:uuid:u1' }),
      card('g1', { kind: 'group', members: { 'urn:uuid:u1': true, u1: true, c1: true, other: true } }),
    ];
    const cleaned = cleanGroupMembers(contacts, new Set(['c1']));
    expect(cleaned[1].members).toEqual({ other: true });
  });

  it('normalizeSuggestions collapses mailbox-shaped names (#672)', () => {
    expect(normalizeSuggestions([
      { name: 'Jane <j@x.com>', email: 'j@x.com' },
      { name: '', email: 'J@x.com' },
      { name: '', email: 'Ann <a@x.com>' },
      { name: 'Grp', email: '', group: { id: 'g', memberCount: 2 } },
    ])).toEqual([
      { name: 'Jane', email: 'j@x.com' },
      { name: 'Ann', email: 'a@x.com' },
      { name: 'Grp', email: '', group: { id: 'g', memberCount: 2 } },
    ]);
  });

  it('uncategorized means "no keywords"', () => {
    const state = {
      ...useContactsStore.getState(),
      contacts: [card('c1', { keywords: { A: true } }), card('c2'), card('g', { kind: 'group' })],
      selectedCategory: { type: 'uncategorized' as const },
    };
    expect(selectVisibleContacts(state, '').map((c) => c.id)).toEqual(['c2']);
  });

  it('selectGroupMembers resolves shared cards by originalId', () => {
    const contacts = [
      card('g1', { kind: 'group', members: { c9: true } }),
      card('acc-team:c9', { originalId: 'c9', isShared: true }),
    ];
    expect(selectGroupMembers({ contacts }, 'g1').map((c) => c.id)).toEqual(['acc-team:c9']);
  });
});

describe('sortContactsByName (#963)', () => {
  const person = (id: string, given: string, surname: string) =>
    card(id, { name: { components: [{ kind: 'given', value: given }, { kind: 'surname', value: surname }], isOrdered: true } });
  const contacts = [
    person('zoe', 'Zoe', 'Adams'),
    person('alice', 'Alice', 'Smith'),
    person('bob', 'bob', 'Smith'),
    card('acme', { organizations: { o1: { name: 'Acme Corp' } } }),
  ];

  it('orders by display name by default', () => {
    expect(sortContactsByName(contacts, false).map((c) => c.id)).toEqual(['acme', 'alice', 'bob', 'zoe']);
  });

  it('puts the surname first with byLastName, keeping families together', () => {
    expect(sortContactsByName(contacts, true).map((c) => c.id)).toEqual(['acme', 'zoe', 'alice', 'bob']);
  });

  it('does not reorder its input', () => {
    const input = [...contacts];
    sortContactsByName(input, true);
    expect(input.map((c) => c.id)).toEqual(['zoe', 'alice', 'bob', 'acme']);
  });

  it('compares case- and accent-insensitively, keeping ties in list order (PF10)', () => {
    const named = (id: string, full: string) => card(id, { name: { full } });
    const list = [named('z', 'Zed'), named('e2', 'emile'), named('e1', 'Émile'), named('a', 'Anna')];
    expect(sortContactsByName(list, false).map((c) => c.id)).toEqual(['a', 'e2', 'e1', 'z']);
  });
});

describe('selectCreateTargetBookId', () => {
  const books = [
    { id: 'personal', name: 'Personal', isDefault: true },
    { id: 'work', name: 'Work' },
    { id: 'acc-team:shared', name: 'Team', myRights: { mayWrite: false } },
  ] as AddressBook[];

  it('creates in the address book being viewed', () => {
    expect(selectCreateTargetBookId({ type: 'addressBook', addressBookId: 'work' }, books)).toBe('work');
  });

  it('leaves the default book to the form everywhere else', () => {
    expect(selectCreateTargetBookId({ type: 'all' }, books)).toBeUndefined();
    expect(selectCreateTargetBookId({ type: 'keyword', keyword: 'VIP' }, books)).toBeUndefined();
    expect(selectCreateTargetBookId({ type: 'group', groupId: 'g1' }, books)).toBeUndefined();
  });

  it('never targets a read-only or vanished book', () => {
    expect(selectCreateTargetBookId({ type: 'addressBook', addressBookId: 'acc-team:shared' }, books)).toBeUndefined();
    expect(selectCreateTargetBookId({ type: 'addressBook', addressBookId: 'gone' }, books)).toBeUndefined();
  });
});
