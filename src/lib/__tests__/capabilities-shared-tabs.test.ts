import { describe, it, expect, vi, beforeEach } from 'vitest';

// The settings panes a shared/group account can be managed in follow that
// account's own capabilities. Stalwart doesn't always advertise them on
// shared accounts, so a non-personal account counts as capable as long as
// the server offers the feature at all.

const client = vi.hoisted(() => ({
  accountId: 'own',
  currentSession: null as unknown,
}));
vi.mock('../../api/jmap-client', () => ({ jmapClient: client }));
vi.mock('../../stores/auth-store', () => ({ useAuthStore: { getState: () => ({ session: null }) } }));
vi.mock('../../stores/locale-store', () => ({ t: (_k: string, f?: string) => f ?? _k }));

import { sharedAccountSettingsTabs } from '../capabilities';
import { CAPABILITIES } from '../../api/types';

const ALL = {
  [CAPABILITIES.CORE]: {},
  [CAPABILITIES.MAIL]: {},
  [CAPABILITIES.SIEVE]: {},
  [CAPABILITIES.VACATION]: {},
  [CAPABILITIES.CALENDARS]: {},
  [CAPABILITIES.CONTACTS]: {},
};

function session(serverCaps: Record<string, unknown>, accounts: Record<string, unknown>) {
  client.currentSession = { capabilities: serverCaps, accounts, primaryAccounts: { [CAPABILITIES.MAIL]: 'own' } };
}

beforeEach(() => {
  session(ALL, { own: { name: 'me', isPersonal: true, accountCapabilities: ALL } });
});

describe('sharedAccountSettingsTabs', () => {
  it('lists calendar and contacts for a group account the server lists without capabilities', () => {
    session(ALL, {
      own: { name: 'me', isPersonal: true, accountCapabilities: ALL },
      team: { name: 'team', isPersonal: false, accountCapabilities: {} },
    });
    expect(sharedAccountSettingsTabs('team')).toEqual(['filters', 'vacation', 'calendar', 'contacts']);
  });

  it('follows the account\'s own capabilities when it is personal', () => {
    session(ALL, {
      own: { name: 'me', isPersonal: true, accountCapabilities: ALL },
      bob: { name: 'bob', isPersonal: true, accountCapabilities: { [CAPABILITIES.CALENDARS]: {} } },
    });
    expect(sharedAccountSettingsTabs('bob')).toEqual(['calendar']);
  });

  it('leaves out calendar and contacts when the server offers neither', () => {
    const { [CAPABILITIES.CALENDARS]: _c, [CAPABILITIES.CONTACTS]: _k, ...mailOnly } = ALL;
    session(mailOnly, {
      own: { name: 'me', isPersonal: true, accountCapabilities: mailOnly },
      team: { name: 'team', isPersonal: false },
    });
    expect(sharedAccountSettingsTabs('team')).toEqual(['filters', 'vacation']);
  });

  it('lists nothing for an account the session does not have', () => {
    expect(sharedAccountSettingsTabs('gone')).toEqual([]);
  });
});
