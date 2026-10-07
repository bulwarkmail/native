import { describe, it, expect, beforeEach, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Identity } from '../../api/types';
import {
  identityCacheKey,
  readIdentityCache,
  writeIdentityCache,
  removeIdentityCache,
  loadComposerIdentities,
  MAX_CACHED_IDENTITIES,
} from '../identity-cache';

const A = 'a@mail.example.com';
const B = 'b@mail.example.com';

function ident(id: string, extra: Partial<Identity> = {}): Identity {
  return { id, name: `Name ${id}`, email: `${id}@example.com`, mayDelete: true, ...extra };
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('identity cache', () => {
  it('keys the cache by app account', () => {
    expect(identityCacheKey(A)).toBe(`webmail:identities:v1:${A}`);
  });

  it('round-trips what the composer needs, and nothing else', async () => {
    const full = {
      ...ident('i1', {
        replyTo: [{ name: 'R', email: 'r@example.com' }],
        bcc: [{ email: 'b@example.com' }],
        textSignature: '-- me',
        htmlSignature: '<p>me</p>',
        mayDelete: false,
      }),
      somethingElse: 'secret',
    } as Identity;
    await writeIdentityCache(A, [full]);
    const back = await readIdentityCache(A);
    expect(back).toEqual([{
      id: 'i1', name: 'Name i1', email: 'i1@example.com',
      replyTo: [{ name: 'R', email: 'r@example.com' }],
      bcc: [{ email: 'b@example.com' }],
      textSignature: '-- me', htmlSignature: '<p>me</p>', mayDelete: false,
    }]);
  });

  it('keeps each account separate', async () => {
    await writeIdentityCache(A, [ident('a1')]);
    await writeIdentityCache(B, [ident('b1')]);
    expect((await readIdentityCache(A)).map((i) => i.id)).toEqual(['a1']);
    expect((await readIdentityCache(B)).map((i) => i.id)).toEqual(['b1']);
  });

  it('reads nothing for an account that has no cache', async () => {
    expect(await readIdentityCache(A)).toEqual([]);
  });

  it('reads a corrupt value as empty', async () => {
    await AsyncStorage.setItem(identityCacheKey(A), '{not json');
    expect(await readIdentityCache(A)).toEqual([]);
    await AsyncStorage.setItem(identityCacheKey(A), JSON.stringify({ id: 'x' }));
    expect(await readIdentityCache(A)).toEqual([]);
  });

  it('drops malformed rows and keeps the valid ones', async () => {
    await AsyncStorage.setItem(identityCacheKey(A), JSON.stringify([
      { id: 'ok', name: 'Ok', email: 'ok@example.com', mayDelete: true },
      { id: 5, name: 'Bad', email: 'bad@example.com' },
      null,
      { id: 'noemail', name: 'x' },
      { id: 'badreply', name: 'x', email: 'x@example.com', replyTo: 'nope', mayDelete: true },
    ]));
    const back = await readIdentityCache(A);
    expect(back.map((i) => i.id)).toEqual(['ok', 'badreply']);
    expect(back[1].replyTo).toBeUndefined();
  });

  it('bounds the number of identities stored', async () => {
    const many = Array.from({ length: MAX_CACHED_IDENTITIES + 20 }, (_, n) => ident(`i${n}`));
    await writeIdentityCache(A, many);
    expect(await readIdentityCache(A)).toHaveLength(MAX_CACHED_IDENTITIES);
  });

  it('bounds the stored size, dropping identities that do not fit', async () => {
    const huge = 'x'.repeat(200_000);
    await writeIdentityCache(A, [ident('i1'), ident('i2', { htmlSignature: huge }), ident('i3', { htmlSignature: huge })]);
    const raw = await AsyncStorage.getItem(identityCacheKey(A));
    expect(raw!.length).toBeLessThanOrEqual(256 * 1024);
    expect((await readIdentityCache(A)).map((i) => i.id)).toEqual(['i1', 'i2']);
  });

  it('removes only that account\'s cache', async () => {
    await writeIdentityCache(A, [ident('a1')]);
    await writeIdentityCache(B, [ident('b1')]);
    await removeIdentityCache(A);
    expect(await AsyncStorage.getItem(identityCacheKey(A))).toBeNull();
    expect(await readIdentityCache(B)).toHaveLength(1);
  });

  it('never throws on storage errors', async () => {
    const get = vi.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('disk'));
    const setItem = vi.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk'));
    try {
      expect(await readIdentityCache(A)).toEqual([]);
      await expect(writeIdentityCache(A, [ident('a1')])).resolves.toBeUndefined();
    } finally {
      get.mockRestore();
      setItem.mockRestore();
    }
  });
});

describe('loadComposerIdentities', () => {
  it('uses the fresh list and caches it for the account', async () => {
    await writeIdentityCache(A, [ident('old')]);
    const res = await loadComposerIdentities(A, async () => [ident('new')]);
    expect(res).toEqual({ identities: [ident('new')], source: 'fresh', error: null });
    expect((await readIdentityCache(A)).map((i) => i.id)).toEqual(['new']);
  });

  it('falls back to the account\'s cached list when the fetch fails', async () => {
    await writeIdentityCache(A, [ident('a1')]);
    const res = await loadComposerIdentities(A, async () => { throw new Error('offline'); });
    expect(res.source).toBe('cache');
    expect(res.identities.map((i) => i.id)).toEqual(['a1']);
    expect(res.error).toBe('offline');
  });

  it('gives nothing when the fetch fails and there is no cache', async () => {
    const res = await loadComposerIdentities(A, async () => { throw new Error('offline'); });
    expect(res).toEqual({ identities: [], source: 'none', error: 'offline' });
  });

  it('never uses another account\'s cache', async () => {
    await writeIdentityCache(B, [ident('b1')]);
    const res = await loadComposerIdentities(A, async () => { throw new Error('offline'); });
    expect(res).toEqual({ identities: [], source: 'none', error: 'offline' });
  });

  it('without an owner it neither reads nor writes a cache', async () => {
    await writeIdentityCache(A, [ident('a1')]);
    const failed = await loadComposerIdentities(null, async () => { throw new Error('offline'); });
    expect(failed.source).toBe('none');
    const fresh = await loadComposerIdentities(null, async () => [ident('n1')]);
    expect(fresh.source).toBe('fresh');
    expect((await readIdentityCache(A)).map((i) => i.id)).toEqual(['a1']);
  });

  it('a fresh empty list replaces the cached one', async () => {
    await writeIdentityCache(A, [ident('a1')]);
    const res = await loadComposerIdentities(A, async () => []);
    expect(res.source).toBe('fresh');
    expect(await readIdentityCache(A)).toEqual([]);
  });
});
