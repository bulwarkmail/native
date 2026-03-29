import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
  },
}));

import { jmapClient } from '../jmap-client';
import { getIdentities, createIdentity, updateIdentity, deleteIdentity } from '../identity';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('identity operations', () => {
  describe('getIdentities', () => {
    it('should fetch identities', async () => {
      const identities = [{ id: 'id-1', name: 'Me', email: 'me@example.com' }];
      mockRequest.mockResolvedValue({
        methodResponses: [['Identity/get', { list: identities }, '0']],
      });

      const result = await getIdentities();
      expect(result).toEqual(identities);
      expect(mockRequest).toHaveBeenCalledWith(
        [['Identity/get', { accountId: 'acc-1' }, '0']],
        expect.arrayContaining(['urn:ietf:params:jmap:submission']),
      );
    });
  });

  describe('createIdentity', () => {
    it('should create a new identity', async () => {
      const created = { id: 'id-new', name: 'Work', email: 'work@example.com' };
      mockRequest.mockResolvedValue({
        methodResponses: [['Identity/set', { created: { 'new-identity': created } }, '0']],
      });

      const result = await createIdentity({ name: 'Work', email: 'work@example.com' });
      expect(result).toEqual(created);
    });
  });

  describe('updateIdentity', () => {
    it('should update identity fields', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['Identity/set', { updated: {} }, '0']],
      });

      await updateIdentity('id-1', { name: 'Updated Name' });

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].update).toEqual({ 'id-1': { name: 'Updated Name' } });
    });
  });

  describe('deleteIdentity', () => {
    it('should destroy an identity', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['Identity/set', { destroyed: ['id-1'] }, '0']],
      });

      await deleteIdentity('id-1');

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].destroy).toEqual(['id-1']);
    });
  });
});
