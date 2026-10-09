import { describe, it, expect, vi } from 'vitest';

const accounts = [
  { id: 'a@one', serverUrl: 'https://JMAP.One.example:8443/jmap' },
  { id: 'b@two', serverUrl: 'https://mail.two.example./' },
];
vi.mock('../../stores/account-store', () => ({
  useAccountStore: { getState: () => ({ accounts }) },
}));

import { authservHostFor } from '../authserv-host';

describe('authservHostFor', () => {
  it("reads the host from that app account's own server URL", () => {
    expect(authservHostFor('a@one')).toBe('jmap.one.example');
    expect(authservHostFor('b@two')).toBe('mail.two.example');
  });

  it('knows no host for a missing or unknown account', () => {
    expect(authservHostFor(undefined)).toBeNull();
    expect(authservHostFor('')).toBeNull();
    expect(authservHostFor('c@three')).toBeNull();
  });
});
