import { describe, it, expect } from 'vitest';
import { accountRowText } from '../account-utils';

// One person signed in to two mailboxes has the same name on both, so the
// rows in the switcher and in Settings > Account looked alike; only the
// small address line told them apart (webmail 3bb9f7df8).

const ada = { id: 'a', displayName: 'Ada Lovelace', email: 'ada@example.com', username: 'ada@example.com' };
const adaWork = { id: 'b', displayName: 'Ada Lovelace', email: 'ada@work.example', username: 'ada@work.example' };
const bob = { id: 'c', displayName: 'Bob', email: 'bob@example.com', username: 'bob@example.com' };

describe('accountRowText', () => {
  it('shows the name over the address', () => {
    expect(accountRowText(ada, [ada, bob])).toEqual({ title: 'Ada Lovelace', subtitle: 'ada@example.com' });
  });

  it('leads with the address when another account has the same name', () => {
    expect(accountRowText(ada, [ada, adaWork, bob])).toEqual({ title: 'ada@example.com', subtitle: null });
    expect(accountRowText(adaWork, [ada, adaWork, bob])).toEqual({ title: 'ada@work.example', subtitle: null });
    expect(accountRowText(bob, [ada, adaWork, bob]).title).toBe('Bob');
  });

  it('does not repeat an address that is also the name', () => {
    const plain = { id: 'd', displayName: 'carol@example.com', email: 'carol@example.com', username: 'carol@example.com' };
    expect(accountRowText(plain, [plain])).toEqual({ title: 'carol@example.com', subtitle: null });
  });
});
