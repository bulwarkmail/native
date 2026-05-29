import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    getMaxObjectsInGet: () => 500,
  },
}));

import { jmapClient } from '../jmap-client';
import {
  getAddressBooks,
  queryContacts,
  getContacts,
  createContact,
  updateContact,
  deleteContacts,
  createAddressBook,
  updateAddressBook,
  deleteAddressBook,
} from '../contacts';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('contacts operations', () => {
  describe('getAddressBooks', () => {
    it('should fetch address books', async () => {
      const books = [{ id: 'ab-1', name: 'Personal' }];
      mockRequest.mockResolvedValue({
        methodResponses: [['AddressBook/get', { list: books }, '0']],
      });

      const result = await getAddressBooks();
      expect(result).toEqual(books);
      expect(mockRequest).toHaveBeenCalledWith(
        [['AddressBook/get', { accountId: 'acc-1' }, '0']],
        expect.arrayContaining(['urn:ietf:params:jmap:contacts']),
      );
    });
  });

  describe('queryContacts', () => {
    it('should query contacts with text filter', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['ContactCard/query', { ids: ['c1', 'c2'] }, '0']],
      });

      const result = await queryContacts({ text: 'john' });
      expect(result).toEqual(['c1', 'c2']);
    });

    it('should omit filter when none provided', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['ContactCard/query', { ids: [] }, '0']],
      });

      await queryContacts();
      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].filter).toBeUndefined();
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

  describe('createContact', () => {
    it('should create a contact in the specified address book', async () => {
      const created = { id: 'c-new', addressBookIds: { 'ab-1': true } };
      mockRequest.mockResolvedValue({
        methodResponses: [['ContactCard/set', { created: { 'new-contact': created } }, '0']],
      });

      const result = await createContact(
        { name: { components: [{ kind: 'given', value: 'Jane' }] } },
        'ab-1',
      );

      expect(result).toEqual(created);
      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].create['new-contact'].addressBookIds).toEqual({ 'ab-1': true });
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
  });

  describe('deleteContacts', () => {
    it('should destroy contacts by ids', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['ContactCard/set', { destroyed: ['c1', 'c2'] }, '0']],
      });

      await deleteContacts(['c1', 'c2']);

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].destroy).toEqual(['c1', 'c2']);
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
    it('forwards only settable properties', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['AddressBook/set', { updated: { 'ab-1': null } }, '0']],
      });

      await updateAddressBook('ab-1', { name: 'Renamed', id: 'should-be-ignored' } as never);

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].update).toEqual({ 'ab-1': { name: 'Renamed' } });
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
