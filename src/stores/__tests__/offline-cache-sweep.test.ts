import { describe, it, expect, beforeEach } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { sweepOrphanedOfflineCache } from '../offline-cache-store';

const INDEX = 'webmail:offline-cache:index:v2:';
const ENTRY = 'webmail:offline-cache:entry:v2:';
const OUTBOX = 'webmail:outbox:v1:';

async function seed(keys: string[]) {
  for (const k of keys) await AsyncStorage.setItem(k, '{}');
}
const keys = async () => [...(await AsyncStorage.getAllKeys())].sort();

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('sweepOrphanedOfflineCache', () => {
  it('removes entries of accounts no longer registered', async () => {
    await seed([
      `${INDEX}kept@mail.example.com`, `${ENTRY}kept@mail.example.com:e1`,
      `${INDEX}gone@mail.example.com`, `${ENTRY}gone@mail.example.com:e1`, `${ENTRY}gone@mail.example.com:own:e2`,
    ]);
    await sweepOrphanedOfflineCache(['kept@mail.example.com']);
    expect(await keys()).toEqual([`${ENTRY}kept@mail.example.com:e1`, `${INDEX}kept@mail.example.com`]);
  });

  it('keeps a registered account whose id is a prefix of a removed one', async () => {
    await seed([
      `${INDEX}a@mail.example.com`, `${ENTRY}a@mail.example.com:e1`,
      `${INDEX}a@mail.example.com.au`, `${ENTRY}a@mail.example.com.au:e1`,
    ]);
    await sweepOrphanedOfflineCache(['a@mail.example.com']);
    expect(await keys()).toEqual([`${ENTRY}a@mail.example.com:e1`, `${INDEX}a@mail.example.com`]);
  });

  it('does nothing when no account is known', async () => {
    const all = [`${INDEX}a@x`, `${ENTRY}a@x:e1`];
    await seed(all);
    await sweepOrphanedOfflineCache([]);
    expect(await keys()).toEqual([...all].sort());
  });

  it('leaves outbox keys alone', async () => {
    const outbox = [`${OUTBOX}gone@x`, `${OUTBOX}kept@x`];
    await seed([...outbox, `${INDEX}gone@x`, 'unrelated']);
    await sweepOrphanedOfflineCache(['kept@x']);
    expect(await keys()).toEqual([...outbox, 'unrelated'].sort());
  });
});
