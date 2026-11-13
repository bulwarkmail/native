import { describe, it, expect, vi, beforeEach } from 'vitest';

const { client, blob } = vi.hoisted(() => ({
  client: {
    isConnected: true,
    username: 'me@example.com' as string | null,
    serverUrl: 'https://mail.example.com' as string | null,
  },
  blob: {
    uploadBlob: vi.fn(async () => ({ blobId: 'b1', size: 3, type: 'text/plain' })),
    uploadBytes: vi.fn(async () => ({ blobId: 'b2', size: 3, type: 'text/plain' })),
  },
}));
const { auth } = vi.hoisted(() => ({
  auth: { retrySession: vi.fn(async () => true) },
}));
vi.mock('../../api/jmap-client', () => ({ jmapClient: client }));
vi.mock('../../api/blob', () => blob);
vi.mock('../../stores/auth-store', () => ({ useAuthStore: { getState: () => auth } }));

import { useAccountStore } from '../../stores/account-store';
import {
  ComposerLoginMovedError, ComposerOfflineError, loginMovedFrom, uploadBytesForLogin, uploadFileForLogin,
} from '../compose-login';

const LOGIN = 'me@example.com@mail.example.com';

beforeEach(() => {
  vi.clearAllMocks();
  client.serverUrl = 'https://mail.example.com';
  useAccountStore.setState({ activeAccountId: LOGIN });
});

describe('composer writes after an account switch', () => {
  it('uploads into the login the message was started in', async () => {
    await expect(uploadFileForLogin(LOGIN, 'file:///a.txt', 'text/plain')).resolves.toMatchObject({ blobId: 'b1' });
    await expect(uploadBytesForLogin(LOGIN, new Uint8Array([1]), 'text/plain')).resolves.toMatchObject({ blobId: 'b2' });
    expect(blob.uploadBlob).toHaveBeenCalledWith('file:///a.txt', 'text/plain', undefined);
  });

  it("uploads nothing into another login's blob store", async () => {
    useAccountStore.setState({ activeAccountId: 'me@example.com@other.example.org' });
    client.serverUrl = 'https://other.example.org';
    await expect(uploadFileForLogin(LOGIN, 'file:///a.txt', 'text/plain')).rejects.toBeInstanceOf(ComposerLoginMovedError);
    await expect(uploadBytesForLogin(LOGIN, new Uint8Array([1]), 'text/plain')).rejects.toBeInstanceOf(ComposerLoginMovedError);
    expect(blob.uploadBlob).not.toHaveBeenCalled();
    expect(blob.uploadBytes).not.toHaveBeenCalled();
  });

  it('counts a switch the client already serves before the registry says so', () => {
    client.serverUrl = 'https://other.example.org';
    expect(loginMovedFrom(LOGIN)).toBe(true);
  });

  it('writes while the client is still connecting the same login', () => {
    client.isConnected = false;
    expect(loginMovedFrom(LOGIN)).toBe(false);
    client.isConnected = true;
  });
});

describe('composer uploads without a session', () => {
  // A start whose session check found no network drops the session until the
  // session retry runs; the upload asked the client for an account id then
  // and failed with "Not authenticated - call connect() first".
  it('brings the session up before uploading', async () => {
    client.isConnected = false;
    auth.retrySession.mockImplementationOnce(async () => {
      client.isConnected = true;
      return true;
    });
    blob.uploadBlob.mockImplementationOnce(async () => {
      if (!client.isConnected) throw new Error('Not authenticated - call connect() first');
      return { blobId: 'b1', size: 3, type: 'text/plain' };
    });
    await expect(uploadFileForLogin(LOGIN, 'file:///a.png', 'image/png')).resolves.toMatchObject({ blobId: 'b1' });
    expect(auth.retrySession).toHaveBeenCalledTimes(1);
  });

  it("says the device is offline when the session doesn't come up", async () => {
    client.isConnected = false;
    auth.retrySession.mockImplementationOnce(async () => false);
    await expect(uploadFileForLogin(LOGIN, 'file:///a.png', 'image/png')).rejects.toBeInstanceOf(ComposerOfflineError);
    await expect(uploadBytesForLogin(LOGIN, new Uint8Array([1]), 'image/png')).rejects.toBeInstanceOf(ComposerOfflineError);
    expect(blob.uploadBlob).not.toHaveBeenCalled();
    expect(blob.uploadBytes).not.toHaveBeenCalled();
    client.isConnected = true;
  });

  it('asks for no session when the client has one', async () => {
    await uploadFileForLogin(LOGIN, 'file:///a.png', 'image/png');
    expect(auth.retrySession).not.toHaveBeenCalled();
  });
});
