// A composer opened offline showed "Identity unavailable" with Send off, and
// stayed so once back online until it was closed and opened again.
import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Identity } from '../../api/types';
import { loadComposerIdentities, readCachedIdentities } from '../identity-cache';

const me = { id: 'i1', name: 'User A', email: 'usera@example.org', mayDelete: false } as Identity;
const offline = () => Promise.reject(new Error('Network request failed'));

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('composer identities', () => {
  it('keeps what the server said for the login', async () => {
    const result = await loadComposerIdentities('usera@host', async () => [me]);
    expect(result).toEqual({ identities: [me], fresh: true, error: null });
    expect(await readCachedIdentities('usera@host')).toEqual([me]);
    expect(await readCachedIdentities('other@host')).toEqual([]);
  });

  it('uses the kept identities when the server cannot be reached', async () => {
    await loadComposerIdentities('usera@host', async () => [me]);
    const result = await loadComposerIdentities('usera@host', offline);
    expect(result).toEqual({ identities: [me], fresh: false, error: null });
  });

  it('reports the error only when nothing was kept', async () => {
    const result = await loadComposerIdentities('usera@host', offline);
    expect(result.identities).toEqual([]);
    expect(result.error).toBe('Network request failed');
  });

  it('is read again by the composer when the connection or the session comes back', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../screens/ComposeScreen.tsx'), 'utf8');
    expect(src).toMatch(/loadComposerIdentities\(login, \(\) => getIdentities\(\)\)/);
    expect(src).toMatch(/\}, \[online, sessionUp, identitiesFresh\]\);/);
  });
});
