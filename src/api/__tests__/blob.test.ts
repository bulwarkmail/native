import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('expo-file-system', () => ({
  File: class {
    constructor(public uri: string) {}
    async bytes() { return new Uint8Array(); }
  },
}));

// The streaming upload path is mocked as a controllable task so the tests
// can drive progress, completion and cancellation.
const uploadTask = {
  uploadAsync: vi.fn(),
  cancelAsync: vi.fn(async () => undefined),
};
const createUploadTask = vi.fn((..._args: unknown[]) => uploadTask);
const copyAsync = vi.fn(async (_options: { from: string; to: string }) => undefined);
const deleteAsync = vi.fn(async (_uri: string, _options?: unknown) => undefined);
vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  createUploadTask: (...args: unknown[]) => createUploadTask(...args),
  copyAsync: (options: { from: string; to: string }) => copyAsync(options),
  deleteAsync: (uri: string, options?: unknown) => deleteAsync(uri, options),
  FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
}));

vi.mock('../../lib/client-cert', () => ({
  getClientCertAlias: vi.fn(async () => null),
  secureFetch: vi.fn(),
}));

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

import { getDownloadUrl, uploadBlob } from '../blob';

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

describe('uploadBlob', () => {
  it('streams the file through a native upload task with auth headers and reports progress', async () => {
    let progressCb: ((d: { totalBytesSent: number; totalBytesExpectedToSend: number }) => void) | undefined;
    createUploadTask.mockImplementationOnce((...args: unknown[]) => {
      progressCb = args[3] as typeof progressCb;
      return uploadTask;
    });
    uploadTask.uploadAsync.mockImplementationOnce(async () => {
      progressCb?.({ totalBytesSent: 50, totalBytesExpectedToSend: 100 });
      return { status: 201, body: JSON.stringify({ blobId: 'blob-1', size: 100, type: 'image/png' }) };
    });
    const onProgress = vi.fn();

    const result = await uploadBlob('file:///tmp/a.png', 'image/png', { onProgress });

    expect(result).toEqual({ blobId: 'blob-1', size: 100, type: 'image/png' });
    expect(onProgress).toHaveBeenCalledWith(50, 100);
    const [url, uri, options] = createUploadTask.mock.calls[0] as unknown as [string, string, { headers: Record<string, string>; httpMethod: string }];
    expect(url).toBe('https://mail.example.com/upload/acc-1/');
    expect(uri).toBe('file:///tmp/a.png');
    expect(options.httpMethod).toBe('POST');
    expect(options.headers).toEqual({ 'Content-Type': 'image/png', Authorization: 'Basic dXNlcjpwYXNz' });
  });

  it('accepts the per-account nested response shape', async () => {
    uploadTask.uploadAsync.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({ 'acc-1': { blobId: 'blob-2', size: 7, type: 'text/plain' } }),
    });
    const result = await uploadBlob('file:///tmp/a.txt', 'text/plain');
    expect(result.blobId).toBe('blob-2');
  });

  it('surfaces HTTP failures with the status code', async () => {
    uploadTask.uploadAsync.mockResolvedValueOnce({ status: 413, body: 'too large' });
    await expect(uploadBlob('file:///tmp/a.bin', 'application/octet-stream')).rejects.toThrow(/413/);
  });

  it('cancels the native task when the signal aborts', async () => {
    const controller = new AbortController();
    uploadTask.uploadAsync.mockImplementationOnce(async () => {
      controller.abort();
      return null;
    });
    await expect(
      uploadBlob('file:///tmp/a.bin', 'application/octet-stream', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(uploadTask.cancelAsync).toHaveBeenCalled();
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      uploadBlob('file:///tmp/a.bin', 'application/octet-stream', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(createUploadTask).not.toHaveBeenCalled();
  });

  it('uploads files on disk directly without copying them', async () => {
    uploadTask.uploadAsync.mockResolvedValueOnce({ status: 200, body: JSON.stringify({ blobId: 'b' }) });
    await uploadBlob('file:///tmp/a.pdf', 'application/pdf');
    expect(copyAsync).not.toHaveBeenCalled();
    expect(deleteAsync).not.toHaveBeenCalled();
  });

  it('copies a shared content:// URI into the cache, uploads the copy and deletes it', async () => {
    uploadTask.uploadAsync.mockResolvedValueOnce({ status: 200, body: JSON.stringify({ blobId: 'blob-3' }) });
    const shared = 'content://media/external/images/media/1000000027';

    const result = await uploadBlob(shared, 'image/png');

    expect(result.blobId).toBe('blob-3');
    const { from, to } = copyAsync.mock.calls[0][0];
    expect(from).toBe(shared);
    expect(to).toMatch(/^file:\/\/\/cache\/upload-/);
    expect(createUploadTask.mock.calls[0][1]).toBe(to);
    expect(deleteAsync).toHaveBeenCalledWith(to, { idempotent: true });
  });

  it('deletes the cache copy when the upload fails', async () => {
    uploadTask.uploadAsync.mockResolvedValueOnce({ status: 500, body: 'boom' });
    await expect(uploadBlob('content://com.example.provider/doc/7', 'application/pdf')).rejects.toThrow(/500/);
    const { to } = copyAsync.mock.calls[0][0];
    expect(deleteAsync).toHaveBeenCalledWith(to, { idempotent: true });
  });

  it('does not upload when the shared file cannot be copied', async () => {
    copyAsync.mockRejectedValueOnce(new Error('Permission Denial'));
    await expect(uploadBlob('content://com.example.provider/doc/8', 'image/jpeg')).rejects.toThrow(/Permission Denial/);
    expect(createUploadTask).not.toHaveBeenCalled();
  });
});
