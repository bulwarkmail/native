import { describe, it, expect, vi, beforeEach } from 'vitest';

const session = {
  primaryAccounts: {} as Record<string, string>,
  accounts: {} as Record<string, { name: string; isPersonal: boolean; accountCapabilities?: Record<string, unknown> }>,
};

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    username: 'me@example.com',
    get currentSession() { return session; },
    request: vi.fn(),
    getMaxObjectsInGet: () => 500,
  },
}));

import { jmapClient } from '../jmap-client';
import {
  getAddressBooks,
  getAllAddressBooks,
  getContactsAccountId,
  getContactCapableAccountIds,
  queryContacts,
  getContacts,
  getAllContacts,
  createContact,
  updateContact,
  deleteContacts,
  createAddressBook,
  updateAddressBook,
  setDefaultAddressBook,
  deleteAddressBook,
} from '../contacts';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  session.primaryAccounts = {};
  session.accounts = {};
});

describe('contacts operations', () => {
  describe('account resolution', () => {
    it('prefers the contacts primary account over the mail account', () => {
      expect(getContactsAccountId()).toBe('acc-1');
      session.primaryAccounts = { 'urn:ietf:params:jmap:contacts': 'acc-contacts' };
      expect(getContactsAccountId()).toBe('acc-contacts');
    });

    it('lists contacts-capable and non-personal accounts after the primary', () => {
      session.accounts = {
        'acc-1': { name: 'me', isPersonal: true },
        'acc-team': { name: 'Team', isPersonal: false },
        'acc-cal': { name: 'Cal', isPersonal: true, accountCapabilities: { 'urn:ietf:params:jmap:calendars': {} } },
        'acc-ct': { name: 'Ct', isPersonal: true, accountCapabilities: { 'urn:ietf:params:jmap:contacts': {} } },
      };
      expect(getContactCapableAccountIds()).toEqual(['acc-1', 'acc-team', 'acc-ct']);
    });
  });

  describe('getAddressBooks', () => {
    it('should fetch address books with an explicit property list', async () => {
      const books = [{ id: 'ab-1', name: 'Personal' }];
      mockRequest.mockResolvedValue({
        methodResponses: [['AddressBook/get', { list: books }, '0']],
      });

      const result = await getAddressBooks();
      expect(result).toEqual(books);
      const call = mockRequest.mock.calls[0][0][0];
      expect(call[0]).toBe('AddressBook/get');
      expect(call[1].accountId).toBe('acc-1');
      expect(call[1].properties).toEqual(expect.arrayContaining(['shareWith', 'myRights', 'isDefault']));
      expect(mockRequest.mock.calls[0][1]).toEqual(expect.arrayContaining(['urn:ietf:params:jmap:contacts']));
    });

    it('throws on a method-level error', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['error', { type: 'serverFail', description: 'boom' }, '0']],
      });
      await expect(getAddressBooks()).rejects.toThrow('boom');
    });
  });

  describe('getAllAddressBooks', () => {
    it('namespaces books from shared accounts and tags them', async () => {
      session.accounts = {
        'acc-1': { name: 'me', isPersonal: true },
        'acc-team': { name: 'Team', isPersonal: false },
      };
      mockRequest
        .mockResolvedValueOnce({ methodResponses: [['AddressBook/get', { list: [{ id: 'default', name: 'Mine' }] }, '0']] })
        .mockResolvedValueOnce({ methodResponses: [['AddressBook/get', { list: [{ id: 'default', name: 'Shared' }] }, '0']] });

      const books = await getAllAddressBooks();
      expect(books).toHaveLength(2);
      expect(books[0]).toMatchObject({ id: 'default', originalId: 'default', isShared: false });
      expect(books[1]).toMatchObject({
        id: 'acc-team:default', originalId: 'default', accountId: 'acc-team', accountName: 'Team', isShared: true,
      });
    });

    it('keeps own books when a shared account fails', async () => {
      session.accounts = {
        'acc-1': { name: 'me', isPersonal: true },
        'acc-team': { name: 'Team', isPersonal: false },
      };
      mockRequest
        .mockResolvedValueOnce({ methodResponses: [['AddressBook/get', { list: [{ id: 'default', name: 'Mine' }] }, '0']] })
        .mockRejectedValueOnce(new Error('forbidden'));

      const books = await getAllAddressBooks();
      expect(books.map((b) => b.id)).toEqual(['default']);
    });
  });

  describe('queryContacts', () => {
    it('should query contacts with text filter', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['ContactCard/query', { ids: ['c1', 'c2'], total: 2 }, '0']],
      });

      const result = await queryContacts({ text: 'john' });
      expect(result).toEqual(['c1', 'c2']);
      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].filter).toEqual({ text: 'john' });
      expect(call[1].position).toBe(0);
    });

    it('should omit filter when none provided', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['ContactCard/query', { ids: [] }, '0']],
      });

      await queryContacts();
      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].filter).toBeUndefined();
    });

    it('walks position until every id is collected', async () => {
      mockRequest
        .mockResolvedValueOnce({ methodResponses: [['ContactCard/query', { ids: ['a', 'b'], total: 5 }, '0']] })
        .mockResolvedValueOnce({ methodResponses: [['ContactCard/query', { ids: ['c', 'd'], total: 5 }, '0']] })
        .mockResolvedValueOnce({ methodResponses: [['ContactCard/query', { ids: ['e'], total: 5 }, '0']] });

      const result = await queryContacts(undefined, 2);
      expect(result).toEqual(['a', 'b', 'c', 'd', 'e']);
      expect(mockRequest).toHaveBeenCalledTimes(3);
      expect(mockRequest.mock.calls[1][0][0][1].position).toBe(2);
      expect(mockRequest.mock.calls[2][0][0][1].position).toBe(4);
    });

    it('stops when the server returns a short page without a total', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['ContactCard/query', { ids: ['a'] }, '0']],
      });
      const result = await queryContacts(undefined, 2);
      expect(result).toEqual(['a']);
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });
  });

  describe('getContacts', () => {
    it('should fetch contacts by id', async () => {
      const contacts = [{ id: 'c1', name: { components: [{ kind: 'given', value: 'John' }] } }];
      mockRequest.mockResolvedValue({
        methodResponses: [['ContactCard/get', { list: contacts }, '0']],
      });

      const result = await getContacts(['c1']);
      expect(result).toEqual(contacts);
    });
  });

  describe('getContacts links', () => {
    it('getContacts fills calendarUri from calendars', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['ContactCard/get', { list: [
          { id: 'c1', addressBookIds: {}, calendars: { k: { kind: 'calendar', uri: 'https://c.example/cal' } } },
        ] }, '0']],
      });
      const [card] = await getContacts(['c1']);
      expect(card.calendarUri).toBe('https://c.example/cal');
    });
  });

  describe('getAllContacts', () => {
    it('namespaces cards and their book ids for shared accounts', async () => {
      session.accounts = {
        'acc-1': { name: 'me', isPersonal: true },
        'acc-team': { name: 'Team', isPersonal: false },
      };
      mockRequest
        .mockResolvedValueOnce({ methodResponses: [['ContactCard/query', { ids: ['c1'], total: 1 }, '0']] })
        .mockResolvedValueOnce({ methodResponses: [['ContactCard/get', { list: [{ id: 'c1', addressBookIds: { default: true } }] }, '0']] })
        .mockResolvedValueOnce({ methodResponses: [['ContactCard/query', { ids: ['c9'], total: 1 }, '0']] })
        .mockResolvedValueOnce({ methodResponses: [['ContactCard/get', { list: [{ id: 'c9', addressBookIds: { default: true } }] }, '0']] });

      const cards = await getAllContacts();
      expect(cards[0]).toEqual({ id: 'c1', addressBookIds: { default: true } });
      expect(cards[1]).toMatchObject({
        id: 'acc-team:c9',
        originalId: 'c9',
        addressBookIds: { 'acc-team:default': true },
        accountId: 'acc-team',
        isShared: true,
      });
    });
  });

  describe('createContact', () => {
    it('assigns a urn:uuid UID, then re-fetches the created card', async () => {
      const full = {
        id: 'c-new',
        uid: 'urn:uuid:whatever',
        addressBookIds: { 'ab-1': true },
        name: { components: [{ kind: 'given', value: 'Jane' }] },
      };
      mockRequest
        .mockResolvedValueOnce({
          methodResponses: [['ContactCard/set', { created: { 'new-contact': { id: 'c-new' } } }, '0']],
        })
        .mockResolvedValueOnce({
          methodResponses: [['ContactCard/get', { list: [full] }, '0']],
        });

      const result = await createContact(
        { name: { components: [{ kind: 'given', value: 'Jane' }] } },
        'ab-1',
      );

      expect(result).toEqual(full);
      const create = mockRequest.mock.calls[0][0][0][1].create['new-contact'];
      expect(create.addressBookIds).toEqual({ 'ab-1': true });
      expect(create.uid).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
      expect(mockRequest.mock.calls[1][0][0][0]).toBe('ContactCard/get');
      expect(mockRequest.mock.calls[1][0][0][1].ids).toEqual(['c-new']);
    });

    it('keeps an existing uid and strips client-only fields', async () => {
      mockRequest
        .mockResolvedValueOnce({
          methodResponses: [['ContactCard/set', { created: { 'new-contact': { id: 'c-new' } } }, '0']],
        })
        .mockResolvedValueOnce({ methodResponses: [['ContactCard/get', { list: [] }, '0']] });

      const result = await createContact(
        { uid: 'urn:uuid:keep', isShared: true, accountName: 'x', name: { full: 'A' } },
        'ab-1',
      );
      const create = mockRequest.mock.calls[0][0][0][1].create['new-contact'];
      expect(create.uid).toBe('urn:uuid:keep');
      expect(create.isShared).toBeUndefined();
      expect(create.accountName).toBeUndefined();
      // Falls back to a client-side merge when the re-fetch comes back empty.
      expect(result).toMatchObject({ id: 'c-new', uid: 'urn:uuid:keep', name: { full: 'A' }, addressBookIds: { 'ab-1': true } });
    });

    it('createContact sends calendars, not calendarUri', async () => {
      mockRequest
        .mockResolvedValueOnce({
          methodResponses: [['ContactCard/set', { created: { 'new-contact': { id: 'c-new' } } }, '0']],
        })
        .mockResolvedValueOnce({ methodResponses: [['ContactCard/get', { list: [] }, '0']] });

      await createContact({ name: { full: 'A' }, calendarUri: 'https://c.example/cal' }, 'ab-1');
      const create = mockRequest.mock.calls[0][0][0][1].create['new-contact'];
      expect(create.calendars.cal).toEqual({ '@type': 'Calendar', kind: 'calendar', uri: 'https://c.example/cal' });
      expect(create.calendarUri).toBeUndefined();
    });

    it('throws the server description when the card is rejected', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['ContactCard/set', {
          notCreated: { 'new-contact': { type: 'invalidProperties', description: 'bad date', properties: ['anniversaries'] } },
        }, '0']],
      });
      await expect(createContact({ name: { full: 'A' } }, 'ab-1')).rejects.toThrow('bad date (anniversaries)');
    });
  });

  describe('updateContact', () => {
    it('should update contact fields', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['ContactCard/set', { updated: {} }, '0']],
      });

      await updateContact('c1', { kind: 'individual' });

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].update).toEqual({ c1: { kind: 'individual' } });
    });

    it('throws when the server refuses the update', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['ContactCard/set', { notUpdated: { c1: { type: 'forbidden', description: 'read-only book' } } }, '0']],
      });
      await expect(updateContact('c1', { kind: 'org' })).rejects.toThrow('read-only book');
    });

    it('routes to the given account', async () => {
      mockRequest.mockResolvedValue({ methodResponses: [['ContactCard/set', { updated: {} }, '0']] });
      await updateContact('c1', { kind: 'org' }, 'acc-team');
      expect(mockRequest.mock.calls[0][0][0][1].accountId).toBe('acc-team');
    });
  });

  describe('deleteContacts', () => {
    it('should destroy contacts by ids and return the destroyed ones', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['ContactCard/set', { destroyed: ['c1', 'c2'] }, '0']],
      });

      const destroyed = await deleteContacts(['c1', 'c2']);

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].destroy).toEqual(['c1', 'c2']);
      expect(destroyed).toEqual(['c1', 'c2']);
    });

    it('returns only the destroyed subset on partial failure', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['ContactCard/set', { destroyed: ['c1'], notDestroyed: { c2: { type: 'forbidden' } } }, '0']],
      });
      expect(await deleteContacts(['c1', 'c2'])).toEqual(['c1']);
    });

    it('throws when nothing was destroyed', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['ContactCard/set', { notDestroyed: { c1: { type: 'forbidden', description: 'nope' } } }, '0']],
      });
      await expect(deleteContacts(['c1'])).rejects.toThrow('nope');
    });
  });

  describe('createAddressBook', () => {
    it('creates a book and returns the created entity', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['AddressBook/set', { created: { 'new-book': { id: 'ab-9' } } }, '0']],
      });

      const book = await createAddressBook('Work');

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].create).toEqual({ 'new-book': { name: 'Work' } });
      expect(book).toEqual({ id: 'ab-9', name: 'Work' });
    });

    it('throws when the server refuses to create', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['AddressBook/set', { notCreated: { 'new-book': { description: 'nope' } } }, '0']],
      });
      await expect(createAddressBook('X')).rejects.toThrow('nope');
    });
  });

  describe('updateAddressBook', () => {
    it('forwards only settable properties and never isDefault', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['AddressBook/set', { updated: { 'ab-1': null } }, '0']],
      });

      await updateAddressBook('ab-1', { name: 'Renamed', isDefault: true, id: 'should-be-ignored' } as never);

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].update).toEqual({ 'ab-1': { name: 'Renamed' } });
    });
  });

  describe('setDefaultAddressBook', () => {
    it('uses onSuccessSetIsDefault', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['AddressBook/set', { updated: {} }, '0']],
      });
      await setDefaultAddressBook('ab-2');
      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1]).toEqual({ accountId: 'acc-1', onSuccessSetIsDefault: 'ab-2' });
    });

    it('throws on a method error', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['error', { type: 'invalidArguments', description: 'no such book' }, '0']],
      });
      await expect(setDefaultAddressBook('ab-x')).rejects.toThrow('no such book');
    });
  });

  describe('deleteAddressBook', () => {
    it('destroys the book by id', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['AddressBook/set', { destroyed: ['ab-1'] }, '0']],
      });

      await deleteAddressBook('ab-1');

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].destroy).toEqual(['ab-1']);
    });

    it('throws when destroy fails', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['AddressBook/set', { notDestroyed: { 'ab-1': { description: 'in use' } } }, '0']],
      });
      await expect(deleteAddressBook('ab-1')).rejects.toThrow('in use');
    });
  });
});
