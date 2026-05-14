import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/contacts', () => ({
  getAddressBooks: vi.fn(),
  queryContacts: vi.fn(),
  getContacts: vi.fn(),
  createContact: vi.fn(),
  updateContact: vi.fn(),
  deleteContacts: vi.fn(),
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
import { useContactsStore } from '../contacts-store';

const mockGetAddressBooks = contactsApi.getAddressBooks as ReturnType<typeof vi.fn>;
const mockQueryContacts = contactsApi.queryContacts as ReturnType<typeof vi.fn>;
const mockGetContacts = contactsApi.getContacts as ReturnType<typeof vi.fn>;
const mockCreateContact = contactsApi.createContact as ReturnType<typeof vi.fn>;
const mockUpdateContact = contactsApi.updateContact as ReturnType<typeof vi.fn>;
const mockDeleteContacts = contactsApi.deleteContacts as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  useContactsStore.getState().reset();
});

describe('contacts-store', () => {
  describe('fetchAddressBooks', () => {
    it('should load address books', async () => {
      const books = [{ id: 'ab-1', name: 'Personal' }];
      mockGetAddressBooks.mockResolvedValue(books);

      await useContactsStore.getState().fetchAddressBooks();

      expect(useContactsStore.getState().addressBooks).toEqual(books);
    });
  });

  describe('fetchContacts', () => {
    it('should query and fetch contacts', async () => {
      mockQueryContacts.mockResolvedValue(['c1', 'c2']);
      const contacts = [{ id: 'c1' }, { id: 'c2' }];
      mockGetContacts.mockResolvedValue(contacts);

      await useContactsStore.getState().fetchContacts({ text: 'john' });

      expect(useContactsStore.getState().contacts).toEqual(contacts);
      expect(useContactsStore.getState().loading).toBe(false);
    });

    it('should handle empty results', async () => {
      mockQueryContacts.mockResolvedValue([]);

      await useContactsStore.getState().fetchContacts();

      expect(useContactsStore.getState().contacts).toEqual([]);
      expect(mockGetContacts).not.toHaveBeenCalled();
    });
  });

  describe('createContact', () => {
    it('should create and append to list', async () => {
      useContactsStore.setState({ contacts: [{ id: 'c1' } as any] });
      const created = { id: 'c-new', addressBookIds: { 'ab-1': true } };
      mockCreateContact.mockResolvedValue(created);

      const result = await useContactsStore.getState().createContact({}, 'ab-1');

      expect(result).toEqual(created);
      expect(useContactsStore.getState().contacts).toHaveLength(2);
    });
  });

  describe('updateContact', () => {
    it('should update and merge changes in state', async () => {
      useContactsStore.setState({
        contacts: [{ id: 'c1', kind: 'individual' } as any],
      });
      mockUpdateContact.mockResolvedValue(undefined);

      await useContactsStore.getState().updateContact('c1', { kind: 'org' } as any);

      expect(useContactsStore.getState().contacts[0].kind).toBe('org');
    });
  });

  describe('deleteContact', () => {
    it('should remove from list', async () => {
      useContactsStore.setState({
        contacts: [{ id: 'c1' } as any, { id: 'c2' } as any],
      });
      mockDeleteContacts.mockResolvedValue(undefined);

      await useContactsStore.getState().deleteContact('c1');

      expect(useContactsStore.getState().contacts).toHaveLength(1);
      expect(useContactsStore.getState().contacts[0].id).toBe('c2');
    });
  });
});
