import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
    // Connection-scoped header (jmap-client requestContext / authHeaderFor).
    requestContext: () => ({ gen: 1, authHeader: 'Basic dXNlcjpwYXNz' }),
    authHeaderFor: () => 'Basic dXNlcjpwYXNz', isCurrent: () => true,
  },
}));

import { getDownloadUrl, isStaleUploadCopy, uploadBlob, uploadBytes } from '../blob';
import { secureFetch } from '../../lib/client-cert';
import { setServerReachabilitySink } from '../../lib/server-reachability';

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

describe('isStaleUploadCopy', () => {
  it('flags upload copies an earlier run of the app left behind', () => {
    expect(isStaleUploadCopy('upload-1700000000000-3')).toBe(true);
  });

  it("leaves this run's copies alone, since they may still be uploading", async () => {
    uploadTask.uploadAsync.mockResolvedValueOnce({ status: 200, body: JSON.stringify({ blobId: 'b' }) });
    await uploadBlob('content://com.example.provider/doc/9', 'image/png');
    const name = copyAsync.mock.calls[0][0].to.replace('file:///cache/', '');

    expect(isStaleUploadCopy(name)).toBe(false);
  });

  it('ignores other cache files', () => {
    expect(isStaleUploadCopy('upload-notes.txt')).toBe(false);
    expect(isStaleUploadCopy('bulwark-exports')).toBe(false);
    expect(isStaleUploadCopy('x-upload-1700000000000-3')).toBe(false);
  });
});

// Uploads tell the network store whether the mail server answered.
describe('upload reachability', () => {
  const sink = { response: vi.fn(), unreachable: vi.fn() };
  beforeEach(() => setServerReachabilitySink(sink));
  afterEach(() => setServerReachabilitySink(null));

  it('reports the server answering a streamed upload, even with an error status', async () => {
    uploadTask.uploadAsync.mockResolvedValueOnce({ status: 413, body: 'too large' });
    await expect(uploadBlob('file:///tmp/a.bin', 'application/octet-stream')).rejects.toThrow(/413/);
    expect(sink.response).toHaveBeenCalledTimes(1);
  });

  it('reports nothing for a cancelled streamed upload', async () => {
    const controller = new AbortController();
    uploadTask.uploadAsync.mockImplementationOnce(async () => {
      controller.abort();
      return null;
    });
    await expect(
      uploadBlob('file:///tmp/a.bin', 'application/octet-stream', { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(sink.response).not.toHaveBeenCalled();
    expect(sink.unreachable).not.toHaveBeenCalled();
  });

  it('reports a buffered upload response and a transport failure', async () => {
    vi.mocked(secureFetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ blobId: 'b', size: 1, type: 'text/plain' }),
    } as unknown as Response);
    await uploadBytes(new Uint8Array([1]), 'text/plain');
    expect(sink.response).toHaveBeenCalledTimes(1);

    vi.mocked(secureFetch).mockRejectedValueOnce(new TypeError('Network request failed'));
    await expect(uploadBytes(new Uint8Array([1]), 'text/plain')).rejects.toThrow('Network request failed');
    expect(sink.unreachable).toHaveBeenCalledTimes(1);
  });
});
