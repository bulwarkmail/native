import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: { accountId: 'me', request: vi.fn() },
}));

import { jmapClient } from '../jmap-client';
import { copyBlobs } from '../email';

const request = vi.mocked(jmapClient.request);

beforeEach(() => vi.clearAllMocks());

describe('copyBlobs', () => {
  // Stalwart 0.16.27 and 1.0.0 answer unknownMethod without it (seen live).
  it('names the blob capability, without which Stalwart refuses Blob/copy', async () => {
    request.mockResolvedValueOnce({ methodResponses: [['Blob/copy', { copied: { b1: 'b9' } }, '0']] });

    await expect(copyBlobs('team', ['b1'], 'me')).resolves.toEqual({ b1: 'b9' });

    expect(request).toHaveBeenCalledWith(
      [['Blob/copy', { fromAccountId: 'team', accountId: 'me', blobIds: ['b1'] }, '0']],
      ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:blob'],
    );
  });

  it('sends nothing within one account', async () => {
    await expect(copyBlobs('me', ['b1'], 'me')).resolves.toEqual({ b1: 'b1' });
    expect(request).not.toHaveBeenCalled();
  });

  it('fails when the server copied nothing', async () => {
    request.mockResolvedValueOnce({
      methodResponses: [['Blob/copy', { notCopied: { b1: { type: 'blobNotFound' } } }, '0']],
    });
    await expect(copyBlobs('team', ['b1'], 'me')).rejects.toThrow('blobNotFound');
  });
});
