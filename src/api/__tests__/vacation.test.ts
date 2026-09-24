import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'own',
    request: vi.fn(),
    currentSession: null as unknown,
  },
}));

import { jmapClient } from '../jmap-client';
import { CAPABILITIES } from '../types';
import {
  accountSupportsVacation,
  getVacationResponse,
  isVacationSupported,
  setVacationResponse,
} from '../vacation';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

function setSession(session: unknown) {
  (jmapClient as { currentSession: unknown }).currentSession = session;
}

beforeEach(() => {
  vi.clearAllMocks();
  setSession({
    primaryAccounts: { [CAPABILITIES.MAIL]: 'own' },
    capabilities: { [CAPABILITIES.VACATION]: {} },
    accounts: {
      own: { name: 'me', isPersonal: true, isReadOnly: false, accountCapabilities: { [CAPABILITIES.VACATION]: {} } },
      team: { name: 'Team', isPersonal: false, isReadOnly: false, accountCapabilities: { [CAPABILITIES.MAIL]: {} } },
      other: { name: 'Other', isPersonal: true, isReadOnly: false, accountCapabilities: { [CAPABILITIES.MAIL]: {} } },
    },
  });
});

describe('accountSupportsVacation', () => {
  const caps = { [CAPABILITIES.VACATION]: {} };

  it('needs the capability in a personal account\'s own capabilities', () => {
    expect(accountSupportsVacation(
      { name: 'me', isPersonal: true, isReadOnly: false, accountCapabilities: { [CAPABILITIES.VACATION]: {} } },
      caps,
    )).toBe(true);
    expect(accountSupportsVacation(
      { name: 'me', isPersonal: true, isReadOnly: false, accountCapabilities: { [CAPABILITIES.MAIL]: {} } },
      caps,
    )).toBe(false);
  });

  it('treats shared/group accounts as capable, but only when the server has it', () => {
    expect(accountSupportsVacation({ name: 'grp', isPersonal: false, isReadOnly: false }, caps)).toBe(true);
    expect(accountSupportsVacation({ name: 'grp', isPersonal: false, isReadOnly: false }, {})).toBe(false);
    expect(accountSupportsVacation(undefined, caps)).toBe(false);
  });
});

describe('isVacationSupported', () => {
  it('checks the own mail account by default and a named account on request', () => {
    expect(isVacationSupported()).toBe(true);
    expect(isVacationSupported('team')).toBe(true);
    expect(isVacationSupported('other')).toBe(false);
  });

  it('is false without a session', () => {
    setSession(null);
    expect(isVacationSupported()).toBe(false);
  });
});

describe('account scoping', () => {
  it('reads and writes the responder of the requested account', async () => {
    mockRequest.mockResolvedValueOnce({ methodResponses: [['VacationResponse/get', { list: [] }, '0']] });
    await getVacationResponse('team');
    expect(mockRequest.mock.calls[0][0][0][1]).toEqual({ accountId: 'team', ids: ['singleton'] });

    mockRequest.mockResolvedValueOnce({ methodResponses: [['VacationResponse/set', { updated: {} }, '0']] });
    await setVacationResponse({ isEnabled: true }, 'team');
    expect(mockRequest.mock.calls[1][0][0][1]).toEqual({
      accountId: 'team',
      update: { singleton: { isEnabled: true } },
    });
  });

  it('defaults to the own mail account', async () => {
    mockRequest.mockResolvedValueOnce({ methodResponses: [['VacationResponse/get', { list: [] }, '0']] });
    await getVacationResponse();
    expect(mockRequest.mock.calls[0][0][0][1].accountId).toBe('own');
  });
});
