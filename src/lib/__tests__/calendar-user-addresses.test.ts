import { describe, it, expect, vi, beforeEach } from 'vitest';

// x:Account/get (the principal, for the account aliases) is refused to
// everyone but admins: it used to go out on every start and on the first
// message opened, invitation or not (PF6).

const request = vi.fn();
vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    isConnected: true,
    accountId: 'acc-1',
    serverUrl: 'https://mail.example.com',
    currentSession: { apiUrl: 'https://mail.example.com/jmap/' },
    hasAccountCapability: () => true,
    request: (...args: unknown[]) => request(...args),
  },
}));

// Run effects straight away, like a mount.
vi.mock('react', () => ({
  default: {
    useEffect: (effect: () => void) => { effect(); },
    useReducer: () => [0, () => undefined],
    useMemo: <T,>(fn: () => T) => fn(),
  },
}));

vi.mock('../../stores/account-store', () => ({
  useAccountStore: (select: (s: unknown) => unknown) => select({ getActiveAccount: () => ({ email: 'me@example.com' }) }),
}));
// The signed-in account (server|login|JMAP id), and the identities held for one.
const session = vi.hoisted(() => ({
  scope: 'https://mail.example.com||acc-1' as string | null,
  identities: [] as Array<{ email: string }>,
  identitiesFor: null as string | null,
}));
vi.mock('../../stores/settings-store', () => ({
  useSettingsStore: (select: (s: unknown) => unknown) =>
    select({ identities: session.identities, identitiesFor: session.identitiesFor }),
  identityScope: () => session.scope,
}));

let storedIdentities: Record<string, Array<{ calendarAddress: string }>> = {};
vi.mock('../../stores/calendar-store', () => ({
  useCalendarStore: (select: (s: unknown) => unknown) => select({ participantIdentities: storedIdentities }),
}));

import { useUserCalendarAddresses, resetUserCalendarAddressCache, addressesForAccount } from '../calendar-user-addresses';
import { fetchAccountDisplayName, fetchPrincipal, resetPrincipalRefusals } from '../../api/account-security';

const forbidden = { methodResponses: [['error', { type: 'forbidden' }, '0']] };

beforeEach(() => {
  session.scope = 'https://mail.example.com||acc-1';
  session.identities = [];
  session.identitiesFor = null;
  request.mockReset();
  resetUserCalendarAddressCache();
  resetPrincipalRefusals();
});

describe('the organizing identity counts as the user', () => {
  it('merges the account\'s ParticipantIdentity addresses', () => {
    storedIdentities = { 'acc-1': [{ calendarAddress: 'mailto:work@example.com' }, { calendarAddress: 'mailto:ME@example.com' }] };
    expect(useUserCalendarAddresses(false)).toEqual(['me@example.com', 'work@example.com']);
    storedIdentities = {};
  });
});

describe('account aliases for calendar invitations', () => {
  it('does not look the aliases up for a message without an invitation', () => {
    expect(useUserCalendarAddresses(false)).toEqual(['me@example.com']);
    expect(request).not.toHaveBeenCalled();
  });

  it('asks once, and never again this session once refused', async () => {
    request.mockResolvedValue(forbidden);
    useUserCalendarAddresses(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toEqual([['x:Account/get', { accountId: 'acc-1', ids: ['acc-1'] }, '0']]);
    // Every later view needing them (another invitation, the calendar) reuses that.
    useUserCalendarAddresses(true);

    // Even with the alias cache gone, the refusal is remembered.
    resetUserCalendarAddressCache();
    useUserCalendarAddresses(true);
    await expect(fetchPrincipal()).rejects.toThrow('forbidden');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('keeps asking after a failure that is not a refusal', async () => {
    request.mockRejectedValueOnce(new Error('offline'));
    await expect(fetchPrincipal()).rejects.toThrow('offline');
    request.mockResolvedValueOnce({ methodResponses: [['x:Account/get', { list: [{ name: 'me@example.com', aliases: { a: { name: 'alias@example.com' } } }] }, '0']] });
    await expect(fetchPrincipal()).resolves.toMatchObject({ emails: ['me@example.com', 'alias@example.com'] });
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe('account display name', () => {
  it('reads the full name from x:AccountSettings, which every user may read', async () => {
    request.mockResolvedValue({ methodResponses: [['x:AccountSettings/get', { list: [{ description: ' Ada Lovelace ' }] }, '0']] });
    await expect(fetchAccountDisplayName()).resolves.toBe('Ada Lovelace');
    expect(request).toHaveBeenCalledWith(
      [['x:AccountSettings/get', { accountId: 'acc-1', ids: ['singleton'] }, '0']],
      expect.anything(),
    );
  });
});

describe('only the signed-in account\'s addresses', () => {
  it('counts identities held for this account, not ones left from another', () => {
    session.identities = [{ email: 'work@example.com' }];
    session.identitiesFor = 'https://other.example.com||acc-1';
    expect(useUserCalendarAddresses(false)).toEqual(['me@example.com']);
    session.identitiesFor = session.scope;
    expect(useUserCalendarAddresses(false)).toEqual(['me@example.com', 'work@example.com']);
  });

  it('does not hand one server\'s aliases to another account with the same JMAP id', async () => {
    request.mockResolvedValue({ methodResponses: [['x:Account/get', { list: [{ name: 'me@example.com', aliases: { a: { name: 'alias@example.com' } } }] }, '0']] });
    useUserCalendarAddresses(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(useUserCalendarAddresses(true)).toContain('alias@example.com');
    session.scope = 'https://other.example.com||acc-1';
    request.mockResolvedValue({ methodResponses: [['x:Account/get', { list: [{ name: 'me@example.com' }] }, '0']] });
    expect(useUserCalendarAddresses(true)).not.toContain('alias@example.com');
  });
});

describe('addressesForAccount', () => {
  const mine = ['me@example.com'];
  it('hands the addresses only for the account that is shown and signed in', () => {
    expect(addressesForAccount('a1', { shown: 'a1', signedIn: 'a1' }, mine)).toEqual(mine);
  });
  it('hands none for another account, or while the account is not known', () => {
    expect(addressesForAccount('a2', { shown: 'a1', signedIn: 'a1' }, mine)).toEqual([]);
    // Mid-switch: shown already, the login still the old account's.
    expect(addressesForAccount('a2', { shown: 'a2', signedIn: 'a1' }, mine)).toEqual([]);
    expect(addressesForAccount(undefined, { shown: null, signedIn: null }, mine)).toEqual([]);
  });
});
