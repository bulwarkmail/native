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
vi.mock('../../stores/settings-store', () => ({
  useSettingsStore: (select: (s: unknown) => unknown) => select({ identities: [] }),
}));

import { useUserCalendarAddresses, resetUserCalendarAddressCache } from '../calendar-user-addresses';
import { fetchAccountDisplayName, fetchPrincipal, resetPrincipalRefusals } from '../../api/account-security';

const forbidden = { methodResponses: [['error', { type: 'forbidden' }, '0']] };

beforeEach(() => {
  request.mockReset();
  resetUserCalendarAddressCache();
  resetPrincipalRefusals();
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
