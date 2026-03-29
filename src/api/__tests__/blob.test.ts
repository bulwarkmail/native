import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    currentSession: {
      downloadUrl: 'https://mail.example.com/download/{accountId}/{blobId}/{name}?type={type}',
      uploadUrl: 'https://mail.example.com/upload/{accountId}/',
    },
    authHeader: 'Basic dXNlcjpwYXNz',
  },
}));

import { getDownloadUrl } from '../blob';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('blob operations', () => {
  describe('getDownloadUrl', () => {
    it('should construct download URL from template', () => {
      const url = getDownloadUrl('blob-123', 'document.pdf', 'application/pdf');

      expect(url).toBe(
        'https://mail.example.com/download/acc-1/blob-123/document.pdf?type=application%2Fpdf',
      );
    });

    it('should use default name and type when not provided', () => {
      const url = getDownloadUrl('blob-456');

      expect(url).toContain('blob-456');
      expect(url).toContain('download');
      expect(url).toContain('application%2Foctet-stream');
    });

    it('should encode special characters in name', () => {
      const url = getDownloadUrl('blob-789', 'my file (1).pdf', 'application/pdf');

      expect(url).toContain('my%20file%20(1).pdf');
    });
  });
});
