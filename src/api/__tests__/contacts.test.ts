import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
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

    it('should use default empty filter', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['ContactCard/query', { ids: [] }, '0']],
      });

      await queryContacts();
      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].filter).toEqual({});
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
});
