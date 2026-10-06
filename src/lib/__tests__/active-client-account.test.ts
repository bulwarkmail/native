import { beforeEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({ username: null as string | null, serverUrl: null as string | null }));
vi.mock('../../api/jmap-client', () => ({ jmapClient: client }));

import { useAccountStore } from '../../stores/account-store';
import { clientServesActiveAccount } from '../active-client-account';

type Entry = { id: string; username: string; serverUrl: string };

function setup(entries: Entry[], active: string, username: string, serverUrl: string) {
  useAccountStore.setState({ accounts: entries, activeAccountId: active } as never);
  client.username = username;
  client.serverUrl = serverUrl;
}
const one = (username: string, serverUrl: string): Entry[] => [{ id: 'a1', username, serverUrl }];

beforeEach(() => {
  useAccountStore.setState({ accounts: [], activeAccountId: null } as never);
  client.username = null;
  client.serverUrl = null;
});

describe('clientServesActiveAccount', () => {
  it('matches identical credentials', () => {
    setup(one('ada@example.com', 'https://mail.example.com'), 'a1', 'ada@example.com', 'https://mail.example.com');
    expect(clientServesActiveAccount()).toBe(true);
  });

  it('ignores case and surrounding whitespace in the username', () => {
    setup(one('ada@example.com', 'https://mail.example.com'), 'a1', ' Ada@Example.com ', 'https://mail.example.com');
    expect(clientServesActiveAccount()).toBe(true);
  });

  it('ignores a trailing slash and the case of the host', () => {
    setup(one('ada', 'https://Mail.Example.com/'), 'a1', 'ada', 'https://mail.example.com');
    expect(clientServesActiveAccount()).toBe(true);
    setup(one('ada', 'https://mail.example.com'), 'a1', 'ada', 'https://MAIL.example.com//');
    expect(clientServesActiveAccount()).toBe(true);
  });

  it('does not match a different username', () => {
    setup(one('ada', 'https://mail.example.com'), 'a1', 'grace', 'https://mail.example.com');
    expect(clientServesActiveAccount()).toBe(false);
    setup(one('ada', 'https://mail.example.com'), 'a1', 'ada2', 'https://mail.example.com');
    expect(clientServesActiveAccount()).toBe(false);
    setup(one('ada', 'https://mail.example.com'), 'a1', 'a da', 'https://mail.example.com');
    expect(clientServesActiveAccount()).toBe(false);
  });

  it('does not match a different host, port, scheme or path', () => {
    const e = one('ada', 'https://mail.example.com');
    setup(e, 'a1', 'ada', 'https://mail.example.org');
    expect(clientServesActiveAccount()).toBe(false);
    setup(e, 'a1', 'ada', 'https://mail.example.com:8443');
    expect(clientServesActiveAccount()).toBe(false);
    setup(e, 'a1', 'ada', 'http://mail.example.com');
    expect(clientServesActiveAccount()).toBe(false);
    setup(e, 'a1', 'ada', 'https://mail.example.com/other');
    expect(clientServesActiveAccount()).toBe(false);
    setup(e, 'a1', 'ada', 'https://xmail.example.com');
    expect(clientServesActiveAccount()).toBe(false);
  });

  it('does not match with no active account or an empty client', () => {
    setup(one('ada', 'https://mail.example.com'), 'missing', 'ada', 'https://mail.example.com');
    expect(clientServesActiveAccount()).toBe(false);
    setup(one('ada', 'https://mail.example.com'), 'a1', '', '');
    expect(clientServesActiveAccount()).toBe(false);
  });

  it('keeps registry accounts that differ only by username case apart', () => {
    // generateAccountId keeps the username's case, so both can be registered.
    const both: Entry[] = [
      { id: 'Ada@mail.example.com', username: 'Ada', serverUrl: 'https://mail.example.com' },
      { id: 'ada@mail.example.com', username: 'ada', serverUrl: 'https://mail.example.com' },
    ];
    setup(both, 'Ada@mail.example.com', 'ada', 'https://mail.example.com');
    expect(clientServesActiveAccount()).toBe(false);
    setup(both, 'Ada@mail.example.com', 'Ada', 'https://mail.example.com');
    expect(clientServesActiveAccount()).toBe(true);
    setup(both, 'ada@mail.example.com', 'ada', 'https://mail.example.com');
    expect(clientServesActiveAccount()).toBe(true);
  });
});
