import { describe, it, expect, vi } from 'vitest';

vi.mock('../../api/jmap-client', () => ({ jmapClient: { accountId: 'own', currentSession: null } }));
vi.mock('../../stores/auth-store', () => ({ useAuthStore: { getState: () => ({ session: null }) } }));
vi.mock('../../stores/locale-store', () => ({ t: (_k: string, f?: string) => f ?? _k }));

import { sessionSupportsMailShare } from '../capabilities';
import { CAPABILITIES } from '../../api/types';
import type { JMAPSession } from '../../api/types';

const MAIL_SHARE = CAPABILITIES.MAIL_SHARE;

function sessionWith(
  accounts: Record<string, string[]>,
  serverCaps: string[] = [CAPABILITIES.CORE, CAPABILITIES.MAIL],
): JMAPSession {
  const caps = (list: string[]) => Object.fromEntries(list.map((c) => [c, {}]));
  return {
    capabilities: caps(serverCaps),
    accounts: Object.fromEntries(Object.entries(accounts).map(([id, list]) => [
      id, { name: id, isPersonal: true, isReadOnly: false, accountCapabilities: caps(list) },
    ])),
    primaryAccounts: {},
  } as unknown as JMAPSession;
}

describe('sessionSupportsMailShare', () => {
  it('fails closed without a session or an account', () => {
    expect(sessionSupportsMailShare(null, 'a')).toBe(false);
    expect(sessionSupportsMailShare(sessionWith({ a: [MAIL_SHARE] }), null)).toBe(false);
    expect(sessionSupportsMailShare(sessionWith({ a: [MAIL_SHARE] }), undefined)).toBe(false);
  });

  it('reads the folder\'s own account capability, as Stalwart advertises it', () => {
    expect(sessionSupportsMailShare(sessionWith({ a: [MAIL_SHARE] }), 'a')).toBe(true);
    expect(sessionSupportsMailShare(sessionWith({ a: [MAIL_SHARE] }), 'b')).toBe(false);
    expect(sessionSupportsMailShare(sessionWith({ a: [MAIL_SHARE], b: [] }), 'b')).toBe(false);
  });

  it('accepts the capability at session level', () => {
    expect(sessionSupportsMailShare(sessionWith({ a: [] }, [CAPABILITIES.CORE, MAIL_SHARE]), 'a')).toBe(true);
    // Still only for an account the session lists.
    expect(sessionSupportsMailShare(sessionWith({ a: [] }, [CAPABILITIES.CORE, MAIL_SHARE]), 'b')).toBe(false);
  });

  it('is off when neither the account nor the server offers it', () => {
    expect(sessionSupportsMailShare(sessionWith({ a: [CAPABILITIES.MAIL] }), 'a')).toBe(false);
  });
});
