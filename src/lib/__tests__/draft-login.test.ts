import { describe, it, expect } from 'vitest';
import { composerLoginMoved } from '../draft-login';

describe('composerLoginMoved', () => {
  it('stays put while the login the composer opened in is active', () => {
    expect(composerLoginMoved('acc-a', { activeAccountId: 'acc-a', connectedAccountId: 'acc-a' })).toBe(false);
    // Offline cold start: the client is not connected yet.
    expect(composerLoginMoved('acc-a', { activeAccountId: 'acc-a', connectedAccountId: null })).toBe(false);
  });

  it('moves once another login is active or the client serves another one', () => {
    expect(composerLoginMoved('acc-a', { activeAccountId: 'acc-b', connectedAccountId: 'acc-b' })).toBe(true);
    // Mid-switch: the registry still names A, the client already serves B.
    expect(composerLoginMoved('acc-a', { activeAccountId: 'acc-a', connectedAccountId: 'acc-b' })).toBe(true);
  });

  it('never blocks a composer opened without a login', () => {
    expect(composerLoginMoved(null, { activeAccountId: 'acc-b', connectedAccountId: 'acc-b' })).toBe(false);
  });
});
