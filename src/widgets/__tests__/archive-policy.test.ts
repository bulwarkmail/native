import { beforeEach, describe, expect, it } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { readArchiveEnabled } from '../build';

// The organisation's archiveActionEnabled gate reaches the widgets through
// the policy the app cached (stores/policy-store.ts, key org-policy-cache).

const WEBMAIL = 'https://webmail.example.org';
const account = { id: 'acc', email: 'ada@example.org', webmailUrl: WEBMAIL };

function cache(features: Record<string, unknown>, webmailUrl = WEBMAIL, scopes: unknown[] = []) {
  return AsyncStorage.setItem('org-policy-cache', JSON.stringify({
    state: {
      byAccount: {
        acc: {
          policy: { restrictions: {}, features, defaults: {}, themePolicy: {}, scopes },
          partial: false,
          fetchedAt: 1,
          webmailUrl,
        },
      },
    },
    version: 0,
  }));
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('readArchiveEnabled', () => {
  it('is off when the cached policy turns archiving off', async () => {
    await cache({ archiveActionEnabled: false });
    expect(await readArchiveEnabled(account)).toBe(false);
  });

  it('is on when the policy allows it, without a policy and without a webmail', async () => {
    expect(await readArchiveEnabled(account)).toBe(true);
    await cache({ archiveActionEnabled: true });
    expect(await readArchiveEnabled(account)).toBe(true);
    await cache({ archiveActionEnabled: false });
    expect(await readArchiveEnabled({ ...account, webmailUrl: undefined })).toBe(true);
    expect(await readArchiveEnabled(undefined)).toBe(true);
  });

  it('ignores a policy cached from another webmail', async () => {
    await cache({ archiveActionEnabled: false }, 'https://elsewhere.example.org');
    expect(await readArchiveEnabled(account)).toBe(true);
  });
});
