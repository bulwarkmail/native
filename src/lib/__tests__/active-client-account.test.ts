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

  it('ignores surrounding whitespace and the case of the domain in the username', () => {
    setup(one('ada@example.com', 'https://mail.example.com'), 'a1', ' ada@Example.COM ', 'https://mail.example.com');
    expect(clientServesActiveAccount()).toBe(true);
    setup(one('ada@example.com ', 'https://mail.example.com'), 'a1', 'ada@example.com', 'https://mail.example.com');
    expect(clientServesActiveAccount()).toBe(true);
    setup(one(' ada', 'https://mail.example.com'), 'a1', 'ada ', 'https://mail.example.com');
    expect(clientServesActiveAccount()).toBe(true);
  });

  it('keeps the local part case-sensitive, including an unregistered variant mid add-account', () => {
    // Registry holds `ada`; the client already carries `Ada` (connect sets it
    // before the new account is registered).
    setup(one('ada@example.com', 'https://mail.example.com'), 'a1', 'Ada@example.com', 'https://mail.example.com');
    expect(clientServesActiveAccount()).toBe(false);
    setup(one('ada', 'https://mail.example.com'), 'a1', 'Ada', 'https://mail.example.com');
    expect(clientServesActiveAccount()).toBe(false);
  });

  it('does not match a URL with userinfo or a query', () => {
    setup(one('ada', 'https://mail.example.com'), 'a1', 'ada', 'https://u:p@mail.example.com');
    expect(clientServesActiveAccount()).toBe(false);
    setup(one('ada', 'https://mail.example.com'), 'a1', 'ada', 'https://mail.example.com/?x=1');
    expect(clientServesActiveAccount()).toBe(false);
    setup(one('ada', 'https://u@mail.example.com'), 'a1', 'ada', 'https://u@mail.example.com');
    expect(clientServesActiveAccount()).toBe(false);
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
});
