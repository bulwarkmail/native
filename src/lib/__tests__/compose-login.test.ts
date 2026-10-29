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
vi.mock('../../api/jmap-client', () => ({ jmapClient: client }));
vi.mock('../../api/blob', () => blob);

import { useAccountStore } from '../../stores/account-store';
import {
  ComposerLoginMovedError, loginMovedFrom, uploadBytesForLogin, uploadFileForLogin,
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
