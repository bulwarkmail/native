import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Once a policy for the client's account is cached, the store shares the account with the native
// push code again (shareAccountWithExtension), so what that code shows follows the organisation
// rule devices.pushWithoutContent: the iOS notification extension reads the rule from its entry,
// and Android's native lookup gets no entry while the rule is on
// (push-without-content-android-native.test.ts).

const { client, mockFetch, share } = vi.hoisted(() => ({
  client: {
    serverUrl: 'https://mail.example.com' as string | null,
    username: 'ada@example.com' as string | null,
    usesBearerAuth: true,
    authHeader: 'Bearer test-token',
    currentSession: null as unknown,
    accountId: 'jmap-primary',
    ensureFreshToken: vi.fn(async () => undefined),
  },
  mockFetch: vi.fn(),
  share: vi.fn(async () => undefined),
}));

vi.mock('../../api/jmap-client', () => ({ jmapClient: client }));
vi.mock('../../lib/client-cert', () => ({ fetchWithoutForeignRedirect: mockFetch, secureFetch: mockFetch }));
vi.mock('../../lib/push-notifications', () => ({ shareAccountWithExtension: share }));
vi.mock('../auth-store', async () => {
  const { create } = await import('zustand');
  return { useAuthStore: create(() => ({ activeAccountId: null as string | null, session: null as unknown })) };
});

import { Platform } from 'react-native';
import { useAuthStore } from '../auth-store';
import { useAccountStore, type AccountEntry } from '../account-store';
import { resetPolicyRulesForTests } from '../settings-store';
import { usePolicyStore } from '../policy-store';

const WEBMAIL = 'https://webmail.example.org';
const ADA = 'ada@example.com@mail.example.com';

function account(id: string, username: string, serverUrl: string, webmailUrl: string): AccountEntry {
  return {
    id, serverUrl, username, displayName: username, email: username, avatarColor: '#000',
    lastLoginAt: 1, isConnected: true, hasError: false, isDefault: false, webmailUrl,
  };
}

function response(url: string, data: unknown): Response {
  return {
    ok: true, status: 200, url, redirected: false,
    headers: { get: () => null },
    json: async () => data,
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPolicyRulesForTests();
  client.serverUrl = 'https://mail.example.com';
  client.username = 'ada@example.com';
  mockFetch.mockImplementation(async (url: string) => {
    if (url === `${WEBMAIL}/api/config`) return response(url, {});
    if (url === `${WEBMAIL}/api/admin/policy`) {
      return response(url, {
        restrictions: {}, features: {}, defaults: {}, themePolicy: {},
        organisation: { devices: { pushWithoutContent: true } },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  useAccountStore.setState({
    accounts: [account(ADA, 'ada@example.com', 'https://mail.example.com', WEBMAIL)],
    activeAccountId: ADA,
    defaultAccountId: ADA,
  });
  useAuthStore.setState({ activeAccountId: ADA, session: null });
  usePolicyStore.setState({ byAccount: {}, configByAccount: {}, accountId: null, effective: null, links: {}, configPending: true });
});

afterEach(() => {
  (Platform as { OS: string }).OS = 'android';
  resetPolicyRulesForTests();
});

describe('sharing the account with the native push code after a policy refresh', () => {
  it.each(['ios', 'android'])('shares the client\'s account again on %s once its policy is cached', async (os) => {
    (Platform as { OS: string }).OS = os;
    await usePolicyStore.getState().refresh(ADA);
    expect(usePolicyStore.getState().byAccount[ADA]?.policy).toBeTruthy();
    await vi.waitFor(() => expect(share).toHaveBeenCalledWith(ADA, 'jmap-primary'));
  });

  it('leaves an account alone that the client doesn\'t serve', async () => {
    client.username = 'someone-else@example.com';
    await usePolicyStore.getState().refresh(ADA);
    expect(usePolicyStore.getState().byAccount[ADA]?.policy).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(share).not.toHaveBeenCalled();
  });
});
