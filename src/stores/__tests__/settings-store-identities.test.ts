import { describe, it, expect, vi, beforeEach } from 'vitest';

const client = vi.hoisted(() => ({
  accountId: 'acc-1',
  serverUrl: 'https://mail.example',
  username: 'me',
}));

vi.mock('../../api/jmap-client', () => ({ jmapClient: client }));
vi.mock('../../api/identity', () => ({ getIdentities: vi.fn() }));

import { getIdentities } from '../../api/identity';
import { useSettingsStore } from '../settings-store';
import { findReceivingIdentity } from '../../lib/email-headers';
import { signatureIdentityFor } from '../../lib/signature-utils';

const mockGetIdentities = getIdentities as ReturnType<typeof vi.fn>;
const me = { id: 'i1', name: 'Me', email: 'me@example.com' };

beforeEach(() => {
  vi.clearAllMocks();
  client.accountId = 'acc-1';
  client.serverUrl = 'https://mail.example';
  client.username = 'me';
  useSettingsStore.getState().reset();
});

describe('identities', () => {
  it('reads them once per account, even when the account has none', async () => {
    mockGetIdentities.mockResolvedValue([]);

    await useSettingsStore.getState().ensureIdentities();
    await useSettingsStore.getState().ensureIdentities();

    expect(mockGetIdentities).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().identities).toEqual([]);
  });

  it('shares one request between concurrent callers', async () => {
    mockGetIdentities.mockResolvedValue([me]);

    await Promise.all([
      useSettingsStore.getState().ensureIdentities(),
      useSettingsStore.getState().ensureIdentities(),
      useSettingsStore.getState().fetchIdentities(),
    ]);

    expect(mockGetIdentities).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().identities).toEqual([me]);
  });

  it('drops another account’s identities and reads this one’s', async () => {
    mockGetIdentities.mockResolvedValueOnce([me]);
    await useSettingsStore.getState().ensureIdentities();

    client.serverUrl = 'https://other.example';
    let release!: (list: unknown[]) => void;
    mockGetIdentities.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const pending = useSettingsStore.getState().ensureIdentities();

    expect(useSettingsStore.getState().identities).toEqual([]);
    release([{ id: 'i2', name: 'Other', email: 'other@example.com' }]);
    await pending;
    expect(useSettingsStore.getState().identities.map((i) => i.id)).toEqual(['i2']);
  });

  it('asks again after a failed read', async () => {
    mockGetIdentities.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([me]);

    await useSettingsStore.getState().ensureIdentities();
    await useSettingsStore.getState().ensureIdentities();

    expect(mockGetIdentities).toHaveBeenCalledTimes(2);
    expect(useSettingsStore.getState().identities).toEqual([me]);
  });

  // Stalwart 1.x lists the group's identity (team@) ahead of the member's
  // own; the quick reply, read receipts and unsubscribe fall back to the
  // first identity and went out from the group's address.
  it("puts the login's own identity first when the server lists a group's ahead of it", async () => {
    client.username = 'usera@example.org';
    const team = { id: 'i-team', name: 'Team', email: 'team@example.org', mayDelete: true };
    const usera = { id: 'i-usera', name: 'User A', email: 'usera@example.org', mayDelete: true, textSignature: 'User A' };
    mockGetIdentities.mockResolvedValue([team, usera]);

    await useSettingsStore.getState().fetchIdentities();

    const identities = useSettingsStore.getState().identities;
    expect(identities.map((i) => i.id)).toEqual(['i-usera', 'i-team']);
    // The read receipt / unsubscribe sender of a message to a list address.
    const toList = { to: [{ name: 'List', email: 'list@example.net' }] };
    expect(findReceivingIdentity(identities, toList)?.id).toBe('i-usera');
    // A reply from the team address, which has no signature, carries the own one.
    expect(signatureIdentityFor(team, identities)?.id).toBe('i-usera');
  });

  it('keeps a read that lands after switching accounts out of the new one', async () => {
    let release!: (list: unknown[]) => void;
    mockGetIdentities.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const pending = useSettingsStore.getState().ensureIdentities();

    client.accountId = 'acc-2';
    release([me]);
    await pending;

    expect(useSettingsStore.getState().identities).toEqual([]);
    expect(useSettingsStore.getState().identitiesFor).toBeNull();
  });
});
