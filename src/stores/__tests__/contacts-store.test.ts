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
  getContactsInBook: vi.fn(),
  getContactsAccountId: () => 'acc-1',
  getContactCapableAccountIds: () => ['acc-1', 'acc-team'],
  namespaceId: (accountId: string, id: string) => `${accountId}:${id}`,
  stripClientFields: (c: Record<string, unknown>) => {
    const { originalId: _o, accountId: _a, accountName: _n, isShared: _s, ...rest } = c;
    return rest;
  },
}));

vi.mock('../../api/recent-recipients', () => ({
  queryRecentRecipients: vi.fn(),
  searchSentRecipients: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    isConnected: true,
  },
}));

import * as contactsApi from '../../api/contacts';
import * as recentApi from '../../api/recent-recipients';
import {
  useContactsStore,
  cleanGroupMembers,
  normalizeSuggestions,
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
const mockGetContactsInBook = contactsApi.getContactsInBook as ReturnType<typeof vi.fn>;
const mockQueryRecent = recentApi.queryRecentRecipients as ReturnType<typeof vi.fn>;

const card = (id: string, extra: Partial<ContactCard> = {}): ContactCard =>
  ({ id, addressBookIds: { 'ab-1': true }, ...extra }) as ContactCard;

beforeEach(() => {
  vi.clearAllMocks();
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
