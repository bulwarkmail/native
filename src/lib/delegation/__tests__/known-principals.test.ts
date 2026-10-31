import { beforeEach, describe, expect, it } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  DELEGATE_NAMES_KEY,
  pruneRememberedPrincipals,
  rememberPrincipals,
  rememberedPrincipals,
} from '../known-principals';
import type { Principal } from '../../../api/types';

// Ported from the webmail's lib/delegation/__tests__/known-principals.test.ts
// (AsyncStorage instead of localStorage; logins that are gone are pruned).

const person = (id: string): Principal => ({ id, type: 'individual', name: `${id}@example.org`, email: `${id}@example.org` });

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('known principals', () => {
  it('keeps names per login', async () => {
    await rememberPrincipals('acc-1', [person('ck')]);
    await rememberPrincipals('acc-2', [person('cj')]);
    expect([...(await rememberedPrincipals('acc-1')).keys()]).toEqual(['ck']);
    expect([...(await rememberedPrincipals('acc-2')).keys()]).toEqual(['cj']);
  });

  it('keeps both of two remembers sent at once', async () => {
    await Promise.all([rememberPrincipals('acc-1', [person('ck')]), rememberPrincipals('acc-1', [person('cj')])]);
    expect([...(await rememberedPrincipals('acc-1')).keys()].sort()).toEqual(['cj', 'ck']);
  });

  it('forgets the logins that are gone and leaves the others', async () => {
    await rememberPrincipals('acc-1', [person('ck')]);
    await rememberPrincipals('acc-2', [person('cj')]);
    await pruneRememberedPrincipals(['acc-2']);
    expect((await rememberedPrincipals('acc-1')).size).toBe(0);
    expect([...(await rememberedPrincipals('acc-2')).keys()]).toEqual(['cj']);
  });

  it('leaves no key behind when everyone signed out', async () => {
    await rememberPrincipals('acc-1', [person('ck')]);
    await pruneRememberedPrincipals([]);
    expect(await AsyncStorage.getItem(DELEGATE_NAMES_KEY)).toBeNull();
  });

  it('keeps at most 200 per login, dropping the oldest', async () => {
    await rememberPrincipals('acc-1', Array.from({ length: 205 }, (_, i) => person(`p${i}`)));
    const ids = [...(await rememberedPrincipals('acc-1')).keys()];
    expect(ids).toHaveLength(200);
    expect(ids[0]).toBe('p5');
  });
});
