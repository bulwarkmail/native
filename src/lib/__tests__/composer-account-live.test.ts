import { describe, it, expect, vi, beforeEach } from 'vitest';

const client = vi.hoisted(() => ({
  onAuthFailure: () => () => undefined,
  onTokenRefresh: () => () => undefined,
  accountId: 'jmap-a',
  isConnected: false,
  connectedAccountId: null as string | null,
  username: null as string | null,
  serverUrl: null as string | null,
}));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: client,
  AuthenticationError: class AuthenticationError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));

vi.mock('../push-notifications', () => ({
  teardownPushNotifications: vi.fn(async () => undefined),
  teardownPushNotificationsForAccount: vi.fn(async () => undefined),
}));

import { useAuthStore } from '../../stores/auth-store';
import { useEmailStore } from '../../stores/email-store';
import { useAccountStore, type AccountEntry } from '../../stores/account-store';
import { useSendQueueStore } from '../../stores/send-queue-store';
import { composerOwnerAtMount, liveComposerOwnerCheck, queueJmapAccountId } from '../composer-account';
import { clientServesAccount, recordedJmapAccountId } from '../active-client-account';
import { buildQueuedSend, hasQueueAccounts } from '../queue-send';

describe('liveComposerOwnerCheck', () => {
  const owner = { appAccountId: 'app-a', jmapAccountId: 'jmap-a' };

  it('reflects an account switch made after it was created', () => {
    useAuthStore.setState({ activeAccountId: 'app-a' });
    useEmailStore.setState({ activeAccountId: 'app-a' });
    const ownerActiveNow = liveComposerOwnerCheck(owner, { auth: useAuthStore, view: useEmailStore });
    expect(ownerActiveNow()).toBe(true);

    // The email store swaps its view first, before the client has switched.
    useEmailStore.setState({ activeAccountId: 'app-b' });
    expect(ownerActiveNow()).toBe(false);

    useAuthStore.setState({ activeAccountId: 'app-b' });
    expect(ownerActiveNow()).toBe(false);

    useAuthStore.setState({ activeAccountId: 'app-a' });
    useEmailStore.setState({ activeAccountId: 'app-a' });
    expect(ownerActiveNow()).toBe(true);
  });
});

describe('queueing a send after an offline cold start', () => {
  const account = (id: string, username: string, jmapAccountId?: string): AccountEntry => ({
    id, serverUrl: 'https://mail.example.com', username, email: username, displayName: '', avatarColor: '#000',
    lastLoginAt: 0, isConnected: false, hasError: false, isDefault: false,
    ...(jmapAccountId ? { jmapAccountId } : {}),
  });

  // What the composer and the quick reply evaluate at send time.
  const queueId = (owner: ReturnType<typeof composerOwnerAtMount>) => queueJmapAccountId(owner, {
    liveJmapAccountId: client.connectedAccountId,
    clientServesOwner: !!owner && clientServesAccount(owner.appAccountId),
    recorded: recordedJmapAccountId,
  });
  const mount = (appId: string) => composerOwnerAtMount({
    activeAppAccountId: appId,
    activeJmapAccountId: client.isConnected && clientServesAccount(appId) ? client.accountId : null,
    recordedJmapAccountId,
  });

  beforeEach(async () => {
    Object.assign(client, { isConnected: false, connectedAccountId: null, username: null, serverUrl: null });
    useAccountStore.setState({
      accounts: [account('app-a', 'a@example.com', 'jmap-a'), account('app-b', 'b@example.com', 'jmap-b'), account('app-c', 'c@example.com')],
    });
    for (const id of ['app-a', 'app-b', 'app-c']) await useSendQueueStore.getState().clearAccount(id);
  });

  it('enqueues with the id recorded for the owner', async () => {
    const owner = mount('app-a');
    const jmapAccountId = queueId(owner);
    expect(hasQueueAccounts(owner!.appAccountId, jmapAccountId)).toBe(true);
    await useSendQueueStore.getState().hydrateAccount('app-a');
    await useSendQueueStore.getState().enqueue(buildQueuedSend({
      id: 'q1', appAccountId: owner!.appAccountId, jmapAccountId, identityId: 'i1', draftId: null,
      outgoing: { from: [{ email: 'a@example.com' }], to: [{ email: 'x@example.com' }], subject: 's', textBody: 'hi', messageId: 'm1@example.com' },
    }));
    expect(useSendQueueStore.getState().entries['app-a']).toEqual([
      expect.objectContaining({ appAccountId: 'app-a', jmapAccountId: 'jmap-a' }),
    ]);
  });

  it('an account never connected on this install has nothing to queue against', () => {
    const owner = mount('app-c');
    expect(owner).toEqual({ appAccountId: 'app-c', jmapAccountId: '' });
    expect(hasQueueAccounts('app-c', queueId(owner))).toBe(false);
  });

  it('a client connected for another account never lends the owner its id', () => {
    Object.assign(client, {
      isConnected: true, connectedAccountId: 'jmap-b-live', accountId: 'jmap-b-live',
      username: 'b@example.com', serverUrl: 'https://mail.example.com',
    });
    expect(mount('app-a')).toEqual({ appAccountId: 'app-a', jmapAccountId: 'jmap-a' });
    expect(queueId(mount('app-a'))).toBe('jmap-a');
    expect(queueId(mount('app-c'))).toBe('');
    // The account it does serve gets the live id.
    expect(queueId(mount('app-b'))).toBe('jmap-b-live');
  });

  it('a connection that came up after mount is picked up at send time', () => {
    const owner = mount('app-c');
    Object.assign(client, {
      isConnected: true, connectedAccountId: 'jmap-c', accountId: 'jmap-c',
      username: 'c@example.com', serverUrl: 'https://mail.example.com',
    });
    expect(queueId(owner)).toBe('jmap-c');
  });
});
