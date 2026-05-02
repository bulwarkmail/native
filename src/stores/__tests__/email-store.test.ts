import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/email', () => ({
  getMailboxes: vi.fn(),
  queryEmails: vi.fn(),
  getEmails: vi.fn(),
  getFullEmail: vi.fn(),
  setEmailKeywords: vi.fn(),
  moveEmail: vi.fn(),
  archiveEmails: vi.fn(),
  restoreEmailMailboxes: vi.fn(),
  deleteEmail: vi.fn(),
  searchEmails: vi.fn(),
}));

// settings-store transitively pulls in jmap-client / expo-secure-store, which
// trip on react-native's Flow-typed entrypoint under vitest. The store only
// reads archiveMode in archiveEmail, so a minimal stub is enough.
vi.mock('../settings-store', () => ({
  useSettingsStore: { getState: () => ({ archiveMode: 'single' }) },
}));

import * as emailApi from '../../api/email';
import { useEmailStore } from '../email-store';

const mockGetMailboxes = emailApi.getMailboxes as ReturnType<typeof vi.fn>;
const mockQueryEmails = emailApi.queryEmails as ReturnType<typeof vi.fn>;
const mockGetEmails = emailApi.getEmails as ReturnType<typeof vi.fn>;
const mockGetFullEmail = emailApi.getFullEmail as ReturnType<typeof vi.fn>;
const mockSetKeywords = emailApi.setEmailKeywords as ReturnType<typeof vi.fn>;
const mockMoveEmail = emailApi.moveEmail as ReturnType<typeof vi.fn>;
const mockDeleteEmail = emailApi.deleteEmail as ReturnType<typeof vi.fn>;
const mockSearchEmails = emailApi.searchEmails as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  useEmailStore.getState().reset();
});

describe('email-store', () => {
  describe('fetchMailboxes', () => {
    it('should load mailboxes', async () => {
      const mailboxes = [
        { id: 'mb-1', name: 'Inbox', role: 'inbox' },
        { id: 'mb-2', name: 'Sent', role: 'sent' },
      ];
      mockGetMailboxes.mockResolvedValue(mailboxes);

      await useEmailStore.getState().fetchMailboxes();

      expect(useEmailStore.getState().mailboxes).toEqual(mailboxes);
    });

    it('should set error on failure', async () => {
      mockGetMailboxes.mockRejectedValue(new Error('Network error'));

      await useEmailStore.getState().fetchMailboxes();

      expect(useEmailStore.getState().error).toBe('Network error');
    });
  });

  describe('selectMailbox', () => {
    it('should query and fetch emails for mailbox', async () => {
      mockQueryEmails.mockResolvedValue({ ids: ['e1', 'e2'], total: 2 });
      const emails = [
        { id: 'e1', subject: 'Email 1' },
        { id: 'e2', subject: 'Email 2' },
      ];
      mockGetEmails.mockResolvedValue(emails);

      await useEmailStore.getState().selectMailbox('mb-1');

      const state = useEmailStore.getState();
      expect(state.currentMailboxId).toBe('mb-1');
      expect(state.emails).toEqual(emails);
      expect(state.totalEmails).toBe(2);
      expect(state.loading).toBe(false);
    });

    it('should handle empty mailbox', async () => {
      mockQueryEmails.mockResolvedValue({ ids: [], total: 0 });

      await useEmailStore.getState().selectMailbox('mb-empty');

      expect(useEmailStore.getState().emails).toEqual([]);
      expect(mockGetEmails).not.toHaveBeenCalled();
    });
  });

  describe('loadMoreEmails', () => {
    it('should append batch to existing emails', async () => {
      // Set up state with initial load
      useEmailStore.setState({
        currentMailboxId: 'mb-1',
        emails: [{ id: 'e1' } as any],
        totalEmails: 2,
        loading: false,
      });

      mockQueryEmails.mockResolvedValue({ ids: ['e2'], total: 2 });
      mockGetEmails.mockResolvedValue([{ id: 'e2', subject: 'Email 2' }]);

      await useEmailStore.getState().loadMoreEmails();

      expect(useEmailStore.getState().emails).toHaveLength(2);
    });

    it('should not load if already at total', async () => {
      useEmailStore.setState({
        currentMailboxId: 'mb-1',
        emails: [{ id: 'e1' } as any, { id: 'e2' } as any],
        totalEmails: 2,
        loading: false,
      });

      await useEmailStore.getState().loadMoreEmails();

      expect(mockQueryEmails).not.toHaveBeenCalled();
    });
  });

  describe('markRead', () => {
    it('should update keywords and optimistically update state', async () => {
      useEmailStore.setState({
        emails: [{ id: 'e1', keywords: {} } as any],
      });
      mockSetKeywords.mockResolvedValue(undefined);

      await useEmailStore.getState().markRead('e1');

      expect(mockSetKeywords).toHaveBeenCalledWith('e1', { $seen: true });
      expect(useEmailStore.getState().emails[0].keywords.$seen).toBe(true);
    });
  });

  describe('markUnread', () => {
    it('should remove $seen keyword', async () => {
      useEmailStore.setState({
        emails: [{ id: 'e1', keywords: { $seen: true, $flagged: true } } as any],
      });
      mockSetKeywords.mockResolvedValue(undefined);

      await useEmailStore.getState().markUnread('e1');

      expect(mockSetKeywords).toHaveBeenCalledWith('e1', { $flagged: true });
      expect(useEmailStore.getState().emails[0].keywords.$seen).toBeUndefined();
    });
  });

  describe('toggleStar', () => {
    it('should add $flagged keyword', async () => {
      useEmailStore.setState({
        emails: [{ id: 'e1', keywords: { $seen: true } } as any],
      });
      mockSetKeywords.mockResolvedValue(undefined);

      await useEmailStore.getState().toggleStar('e1', true);

      expect(useEmailStore.getState().emails[0].keywords.$flagged).toBe(true);
    });

    it('should remove $flagged keyword', async () => {
      useEmailStore.setState({
        emails: [{ id: 'e1', keywords: { $seen: true, $flagged: true } } as any],
      });
      mockSetKeywords.mockResolvedValue(undefined);

      await useEmailStore.getState().toggleStar('e1', false);

      expect(useEmailStore.getState().emails[0].keywords.$flagged).toBeUndefined();
    });
  });

  describe('moveToMailbox', () => {
    it('should move and remove from list', async () => {
      useEmailStore.setState({
        emails: [{ id: 'e1' } as any, { id: 'e2' } as any],
      });
      mockMoveEmail.mockResolvedValue(undefined);

      await useEmailStore.getState().moveToMailbox('e1', 'inbox', 'archive');

      expect(mockMoveEmail).toHaveBeenCalledWith('e1', 'inbox', 'archive');
      expect(useEmailStore.getState().emails).toHaveLength(1);
      expect(useEmailStore.getState().emails[0].id).toBe('e2');
    });
  });

  describe('deleteEmail', () => {
    it('should delete and remove from list', async () => {
      useEmailStore.setState({
        emails: [{ id: 'e1' } as any],
      });
      mockDeleteEmail.mockResolvedValue(undefined);

      await useEmailStore.getState().deleteEmail('e1', 'trash', 'inbox');

      expect(useEmailStore.getState().emails).toHaveLength(0);
    });
  });

  describe('searchEmails', () => {
    it('should search and return full email objects', async () => {
      mockSearchEmails.mockResolvedValue(['e1']);
      mockGetEmails.mockResolvedValue([{ id: 'e1', subject: 'Found' }]);

      const results = await useEmailStore.getState().searchEmails('test');

      expect(results).toEqual([{ id: 'e1', subject: 'Found' }]);
    });

    it('should return empty array for no results', async () => {
      mockSearchEmails.mockResolvedValue([]);

      const results = await useEmailStore.getState().searchEmails('nothing');

      expect(results).toEqual([]);
    });
  });

  describe('getEmailDetail', () => {
    it('should fetch full email', async () => {
      const fullEmail = { id: 'e1', subject: 'Test', bodyValues: { html: { value: '<p>Hi</p>' } } };
      mockGetFullEmail.mockResolvedValue(fullEmail);

      const result = await useEmailStore.getState().getEmailDetail('e1');

      expect(result).toEqual(fullEmail);
    });
  });
});
