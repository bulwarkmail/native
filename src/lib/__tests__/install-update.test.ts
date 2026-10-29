import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const files = new Map<string, Uint8Array>();
const digest = vi.fn();

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-file-system', () => ({
  File: class {
    constructor(private uri: string) {}
    async bytes() { return files.get(this.uri) ?? new Uint8Array(); }
  },
  Paths: { cache: 'file:///cache' },
}));
vi.mock('expo-file-system/legacy', () => ({}));
vi.mock('expo-intent-launcher', () => ({}));
vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digest: (...args: unknown[]) => digest(...args),
}));

import { hashFile } from '../install-update';

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('hashFile', () => {
  const apk = new TextEncoder().encode('not really an apk');

  beforeEach(() => {
    files.clear();
    files.set('file:///cache/app.apk', apk);
    digest.mockReset();
  });

  it('hashes the file natively in one call', async () => {
    digest.mockImplementation(async (_alg: string, data: Uint8Array) => {
      const out = createHash('sha256').update(data).digest();
      return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    });
    expect(await hashFile('file:///cache/app.apk')).toBe(sha256Hex(apk));
    expect(digest).toHaveBeenCalledTimes(1);
    expect(digest).toHaveBeenCalledWith('SHA-256', apk);
  });

  it('falls back to the JS hasher when the native digest fails', async () => {
    digest.mockRejectedValue(new Error('unavailable'));
    expect(await hashFile('file:///cache/app.apk')).toBe(sha256Hex(apk));
  });
});
