import { describe, it, expect } from 'vitest';
import { tokenServerPrefill } from '../token-server';

describe('tokenServerPrefill', () => {
  it('is empty when adding an account and no server was chosen in this flow', () => {
    // The active account's server is not an input: nothing to leak from.
    expect(tokenServerPrefill({ serverUrl: '' })).toBe('');
  });

  it('uses a server confirmed in this flow', () => {
    expect(tokenServerPrefill({ serverUrl: 'https://api.fastmail.com' })).toBe('https://api.fastmail.com');
  });

  it('never reads the known accounts, even when handed to it', () => {
    const flow = { serverUrl: '', knownServerUrl: 'https://self.example.org', accounts: [{ serverUrl: 'https://self.example.org' }] };
    expect(tokenServerPrefill(flow)).toBe('');
  });
});
