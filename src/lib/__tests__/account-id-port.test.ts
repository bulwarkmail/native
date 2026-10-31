import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateAccountId, nonDefaultPort, serverHostLabel, setKnownAccounts } from '../account-utils';
import { useAccountStore } from '../../stores/account-store';

// The same address on two servers on one host was one account: ids were
// username@host, so signing in on http://10.10.10.62:8016 replaced the
// account of http://10.10.10.62:8120. The port is part of the id now, while
// accounts already signed in keep the id they have.

const entry = (username: string, serverUrl: string) => ({
  serverUrl,
  username,
  displayName: username,
  email: username,
  lastLoginAt: 1,
  isConnected: true,
  hasError: false,
});

beforeEach(() => {
  useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
});

afterEach(() => {
  useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
  setKnownAccounts([]);
});

describe('generateAccountId', () => {
  it('keeps the ids of accounts on the default ports', () => {
    expect(generateAccountId('u@example.org', 'https://mail.example.org')).toBe('u@example.org@mail.example.org');
    expect(generateAccountId('u@example.org', 'https://mail.example.org:443/')).toBe('u@example.org@mail.example.org');
    expect(generateAccountId('u@example.org', 'http://mail.example.org:80/jmap')).toBe('u@example.org@mail.example.org');
  });

  it('tells two servers on one host apart by port', () => {
    const a = generateAccountId('usera@example.org', 'http://10.10.10.62:8120');
    const b = generateAccountId('usera@example.org', 'http://10.10.10.62:8016');
    expect(a).toBe('usera@example.org@10.10.10.62:8120');
    expect(b).toBe('usera@example.org@10.10.10.62:8016');
  });

  it('keeps the host-only id of an account signed in before ports counted', () => {
    setKnownAccounts([{ id: 'usera@example.org@10.10.10.62', username: 'usera@example.org', serverUrl: 'http://10.10.10.62:8120' }]);
    expect(generateAccountId('usera@example.org', 'http://10.10.10.62:8120')).toBe('usera@example.org@10.10.10.62');
    expect(generateAccountId('usera@example.org', 'http://10.10.10.62:8120/')).toBe('usera@example.org@10.10.10.62');
    // Another server on the same host is another account.
    expect(generateAccountId('usera@example.org', 'http://10.10.10.62:8016')).toBe('usera@example.org@10.10.10.62:8016');
  });
});

describe('the account registry', () => {
  it('adds the same address on another port of the same host as a second account', () => {
    const store = useAccountStore.getState();
    const a = store.addAccount(entry('usera@example.org', 'http://10.10.10.62:8120'));
    const b = useAccountStore.getState().addAccount(entry('usera@example.org', 'http://10.10.10.62:8016'));
    expect(a).not.toBe(b);
    const { accounts } = useAccountStore.getState();
    expect(accounts.map((x) => x.serverUrl)).toEqual(['http://10.10.10.62:8120', 'http://10.10.10.62:8016']);
  });

  it('keeps an existing account under its old id when another port is added', () => {
    // As persisted by an earlier version.
    useAccountStore.setState({
      accounts: [{
        ...entry('usera@example.org', 'http://10.10.10.62:8120'),
        id: 'usera@example.org@10.10.10.62',
        avatarColor: '#000',
        isDefault: true,
      }],
      activeAccountId: 'usera@example.org@10.10.10.62',
      defaultAccountId: 'usera@example.org@10.10.10.62',
    });
    // Signing in on the old server again updates that account.
    expect(useAccountStore.getState().addAccount(entry('usera@example.org', 'http://10.10.10.62:8120')))
      .toBe('usera@example.org@10.10.10.62');
    const b = useAccountStore.getState().addAccount(entry('usera@example.org', 'http://10.10.10.62:8016'));
    expect(b).toBe('usera@example.org@10.10.10.62:8016');
    expect(useAccountStore.getState().accounts.map((x) => [x.id, x.serverUrl])).toEqual([
      ['usera@example.org@10.10.10.62', 'http://10.10.10.62:8120'],
      ['usera@example.org@10.10.10.62:8016', 'http://10.10.10.62:8016'],
    ]);
  });
});

describe('serverHostLabel', () => {
  it('shows the port only when it is not the default', () => {
    expect(serverHostLabel('https://mail.example.org')).toBe('mail.example.org');
    expect(serverHostLabel('https://mail.example.org:443')).toBe('mail.example.org');
    expect(serverHostLabel('http://10.10.10.62:8016/')).toBe('10.10.10.62:8016');
    expect(serverHostLabel('https://mail.example.org:8443/jmap')).toBe('mail.example.org:8443');
    expect(nonDefaultPort('http://mail.example.org:80')).toBeNull();
    expect(nonDefaultPort('https://mail.example.org:80')).toBe('80');
  });
});
