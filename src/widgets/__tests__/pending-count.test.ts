import { describe, it, expect, beforeEach, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';

vi.mock('react-native', () => ({ Platform: { OS: 'android' }, AppState: {}, NativeModules: {} }));

import { readPendingChanges } from '../build';

const row = (a: string, id: string) => `webmail:sendqueue:v1:${a}:${id}`;
const valid = (a: string, id: string) => JSON.stringify({
  id, appAccountId: a, jmapAccountId: 'j', identityId: 'i', outgoing: { messageId: `${id}@x` }, messageId: `${id}@x`,
  createdAt: '2026-10-04T00:00:00Z', state: 'queued',
});

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('widget pending changes', () => {
  it('counts outbox mutations plus queued sends that hydrate would load', async () => {
    await AsyncStorage.setItem('webmail:outbox:v1:a1', '[1,2]');
    await AsyncStorage.setItem(row('a1', 'e1'), valid('a1', 'e1'));
    await AsyncStorage.setItem(row('a10', 'e2'), valid('a10', 'e2'));
    expect(await readPendingChanges('a1')).toBe(3);
  });

  it('does not count a corrupt queued-send row', async () => {
    await AsyncStorage.setItem(row('a1', 'e1'), valid('a1', 'e1'));
    await AsyncStorage.setItem(row('a1', 'e2'), '{not json');
    await AsyncStorage.setItem(row('a1', 'e3'), JSON.stringify({ state: 'queued' }));
    await AsyncStorage.setItem(row('a1', 'e4'), valid('a1', 'other'));
    expect(await readPendingChanges('a1')).toBe(1);
  });
});
