import { describe, it, expect, beforeEach } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { JMAPSession } from '../../api/types';
import { readServerFingerprint, sessionFingerprint, writeServerFingerprint } from '../server-fingerprint';

// The capability names userc's session listed on the stw10 test servers
// (2026-09-25). 1.0 adds urn:ietf:params:jmap:metadata to the session and the
// account, and urn:ietf:params:jmap:principals:owner to every account.
const SESSION_CAPS_0_16 = [
  'urn:ietf:params:jmap:blob', 'urn:ietf:params:jmap:calendars', 'urn:ietf:params:jmap:calendars:parse',
  'urn:ietf:params:jmap:contacts', 'urn:ietf:params:jmap:contacts:parse', 'urn:ietf:params:jmap:core',
  'urn:ietf:params:jmap:emailpush', 'urn:ietf:params:jmap:filenode', 'urn:ietf:params:jmap:mail',
  'urn:ietf:params:jmap:principals', 'urn:ietf:params:jmap:principals:availability', 'urn:ietf:params:jmap:quota',
  'urn:ietf:params:jmap:sieve', 'urn:ietf:params:jmap:submission', 'urn:ietf:params:jmap:vacationresponse',
  'urn:ietf:params:jmap:webpush-vapid', 'urn:ietf:params:jmap:websocket',
];
const ACCOUNT_CAPS_0_16 = [
  'urn:ietf:params:jmap:blob', 'urn:ietf:params:jmap:calendars', 'urn:ietf:params:jmap:calendars:parse',
  'urn:ietf:params:jmap:contacts', 'urn:ietf:params:jmap:contacts:parse', 'urn:ietf:params:jmap:emailpush',
  'urn:ietf:params:jmap:filenode', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:mail:share',
  'urn:ietf:params:jmap:principals', 'urn:ietf:params:jmap:principals:availability', 'urn:ietf:params:jmap:quota',
  'urn:ietf:params:jmap:sieve', 'urn:ietf:params:jmap:submission', 'urn:ietf:params:jmap:vacationresponse',
  'urn:ietf:params:jmap:websocket', 'urn:stalwart:jmap',
];
const SESSION_CAPS_1_0 = [...SESSION_CAPS_0_16, 'urn:ietf:params:jmap:metadata'];
const ACCOUNT_CAPS_1_0 = [...ACCOUNT_CAPS_0_16, 'urn:ietf:params:jmap:metadata', 'urn:ietf:params:jmap:principals:owner'];

const API_URL = 'https://mail.example.org/jmap/';

function session(opts: {
  sessionCaps: string[];
  accountCaps: string[];
  apiUrl?: string;
  primary?: string;
  state?: string;
  extraAccounts?: Record<string, string[]>;
  values?: (urn: string) => unknown;
}): JMAPSession {
  const primary = opts.primary ?? 'f';
  const caps = (names: string[]) =>
    Object.fromEntries(names.map((urn) => [urn, opts.values?.(urn) ?? {}]));
  const accounts: JMAPSession['accounts'] = {
    [primary]: { name: 'userc@example.org', isPersonal: true, isReadOnly: false, accountCapabilities: caps(opts.accountCaps) },
  };
  for (const [id, names] of Object.entries(opts.extraAccounts ?? {})) {
    accounts[id] = { name: id, isPersonal: false, isReadOnly: false, accountCapabilities: caps(names) };
  }
  return {
    apiUrl: opts.apiUrl ?? API_URL,
    downloadUrl: 'https://mail.example.org/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
    uploadUrl: 'https://mail.example.org/jmap/upload/{accountId}/',
    eventSourceUrl: 'https://mail.example.org/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}',
    primaryAccounts: Object.fromEntries(opts.accountCaps.map((urn) => [urn, primary])),
    accounts,
    capabilities: caps(opts.sessionCaps),
    state: opts.state ?? 'b3bed0bb',
    username: 'userc@example.org',
  };
}

const V0_16 = session({ sessionCaps: SESSION_CAPS_0_16, accountCaps: ACCOUNT_CAPS_0_16 });
const V1_0 = session({ sessionCaps: SESSION_CAPS_1_0, accountCaps: ACCOUNT_CAPS_1_0 });

describe('sessionFingerprint', () => {
  it('tells Stalwart 1.0 from 0.16.23 at the same address', () => {
    expect(sessionFingerprint(V1_0)).not.toBe(sessionFingerprint(V0_16));
    expect(sessionFingerprint(V1_0)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('stays the same for the same server across sessions', () => {
    // The session state is an AHash re-keyed on every Stalwart restart.
    const restarted = session({ sessionCaps: SESSION_CAPS_1_0, accountCaps: ACCOUNT_CAPS_1_0, state: 'fd995b2b' });
    expect(sessionFingerprint(restarted)).toBe(sessionFingerprint(V1_0));

    // Order of the capability names doesn't matter.
    const reordered = session({
      sessionCaps: [...SESSION_CAPS_1_0].reverse(),
      accountCaps: [...ACCOUNT_CAPS_1_0].reverse(),
    });
    expect(sessionFingerprint(reordered)).toBe(sessionFingerprint(V1_0));
  });

  it('ignores capability values and shared accounts, which change with settings and shares', () => {
    const otherLimits = session({
      sessionCaps: SESSION_CAPS_1_0,
      accountCaps: ACCOUNT_CAPS_1_0,
      values: (urn) => (urn === 'urn:ietf:params:jmap:core' ? { maxObjectsInGet: 1000 } : { changed: true }),
    });
    const withShare = session({
      sessionCaps: SESSION_CAPS_1_0,
      accountCaps: ACCOUNT_CAPS_1_0,
      extraAccounts: { d: ['urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:principals:owner'] },
    });
    expect(sessionFingerprint(otherLimits)).toBe(sessionFingerprint(V1_0));
    expect(sessionFingerprint(withShare)).toBe(sessionFingerprint(V1_0));
  });

  it('changes with the API URL, the primary account and the capability names', () => {
    const base = sessionFingerprint(V1_0);
    expect(sessionFingerprint(session({ sessionCaps: SESSION_CAPS_1_0, accountCaps: ACCOUNT_CAPS_1_0, apiUrl: 'https://other.example.org/jmap/' }))).not.toBe(base);
    expect(sessionFingerprint(session({ sessionCaps: SESSION_CAPS_1_0, accountCaps: ACCOUNT_CAPS_1_0, primary: 'b' }))).not.toBe(base);
    // An admin switching a feature off: conservative, the caches go too.
    const noFiles = SESSION_CAPS_1_0.filter((urn) => urn !== 'urn:ietf:params:jmap:filenode');
    expect(sessionFingerprint(session({ sessionCaps: noFiles, accountCaps: ACCOUNT_CAPS_1_0 }))).not.toBe(base);
    const noOwner = ACCOUNT_CAPS_1_0.filter((urn) => urn !== 'urn:ietf:params:jmap:principals:owner');
    expect(sessionFingerprint(session({ sessionCaps: SESSION_CAPS_1_0, accountCaps: noOwner }))).not.toBe(base);
  });

  it('copes with a minimal session', () => {
    const bare = { apiUrl: API_URL } as unknown as JMAPSession;
    expect(sessionFingerprint(bare)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('recorded fingerprints', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('are kept per local account', async () => {
    expect(await readServerFingerprint('userc@mail.example.org')).toBeNull();
    await writeServerFingerprint('userc@mail.example.org', sessionFingerprint(V1_0));
    expect(await readServerFingerprint('userc@mail.example.org')).toBe(sessionFingerprint(V1_0));
    expect(await readServerFingerprint('usera@mail.example.org')).toBeNull();
  });
});
