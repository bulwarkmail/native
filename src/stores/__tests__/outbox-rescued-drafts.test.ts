import { describe, it, expect, vi, beforeEach } from 'vitest';

// A composer whose draft couldn't reach the server (expired session, offline)
// kept it on the device (lib/compose-rescue). The Outbox flush, which runs
// once the account's session is up again, saves it to Drafts and says so.

vi.mock('@react-native-community/netinfo', () => ({
  default: {
    addEventListener: () => () => undefined,
    fetch: async () => ({ isConnected: true, isInternetReachable: true }),
  },
}));

const client = vi.hoisted(() => ({ served: null as string | null }));
vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    get isConnected() { return client.served !== null; },
    get username() { return client.served ? client.served.split('@')[0] : null; },
    get serverUrl() { return client.served ? `https://${client.served.split('@')[1]}` : null; },
  },
}));

const saveDraftVersion = vi.fn(async (..._a: any[]) => ({ id: 'd2', attachments: [] }));
vi.mock('../../api/email', () => ({
  saveDraftVersion: (...a: any[]) => saveDraftVersion(...a),
  patchKeywordsForEmails: vi.fn(async () => undefined),
  setEmailMailboxes: vi.fn(async () => undefined),
  destroyEmails: vi.fn(async () => undefined),
}));

import { useOutboxStore } from '../outbox-store';
import { useNetworkStore } from '../network-store';
import { useToastStore } from '../toast-store';
import {
  composerClosed, composerOpened, forgetRescuedDraft, rescueDraft, rescuedDrafts, type RescuedDraft,
} from '../../lib/compose-rescue';

const ACCOUNT = 'user1@mail.example.org';

function kept(id: string, extra: Partial<RescuedDraft> = {}): RescuedDraft {
  return {
    id,
    savedAt: 1,
    outgoing: { from: [{ email: 'user1@example.org' }], to: [{ email: 'bob@example.org' }], subject: 'Plans', htmlBody: '<p>Hi</p>' } as never,
    draftsMailboxId: 'drafts',
    previousDraftId: 'd1',
    ...extra,
  };
}

const flushed = async () => {
  await useOutboxStore.getState().flush();
  // The kept drafts are saved beside the queue's own flush.
  await vi.waitFor(async () => {
    expect((await rescuedDrafts(ACCOUNT)).filter((d) => !d.id.startsWith('open'))).toEqual([]);
  });
};

beforeEach(async () => {
  vi.clearAllMocks();
  client.served = ACCOUNT;
  useNetworkStore.setState({ online: true, connected: true });
  useToastStore.setState({ toasts: [] });
  for (const d of await rescuedDrafts(ACCOUNT)) await forgetRescuedDraft(ACCOUNT, d.id);
  await useOutboxStore.getState().setAccount(null);
  await useOutboxStore.getState().setAccount(ACCOUNT);
  await useOutboxStore.getState().clear();
  await useOutboxStore.getState().resume(ACCOUNT);
  // Let the kept-draft pass of that flush finish before the test keeps any.
  await new Promise((r) => setTimeout(r, 20));
  saveDraftVersion.mockClear();
});

describe('drafts kept on the device', () => {
  it('go to Drafts, replacing the version saved before, once the session is back', async () => {
    await rescueDraft(ACCOUNT, kept('c1'));
    await flushed();
    expect(saveDraftVersion).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'Plans' }), 'drafts', 'd1', undefined, undefined,
    );
    await vi.waitFor(() => expect(useToastStore.getState().toasts.map((t) => t.title)).toContain('Saved to Drafts'));
  });

  it('stay while the client serves another account, or the server refuses them', async () => {
    await rescueDraft(ACCOUNT, kept('c1'));
    client.served = 'other@mail.example.org';
    await useOutboxStore.getState().flush();
    expect(saveDraftVersion).not.toHaveBeenCalled();
    expect(await rescuedDrafts(ACCOUNT)).toHaveLength(1);

    client.served = ACCOUNT;
    saveDraftVersion.mockRejectedValueOnce(new Error('Session expired'));
    await useOutboxStore.getState().flush();
    await vi.waitFor(() => expect(saveDraftVersion).toHaveBeenCalledTimes(1));
    expect(await rescuedDrafts(ACCOUNT)).toHaveLength(1);
  });

  it('skip a composer that is still open, which saves its own draft', async () => {
    composerOpened('open-1');
    await rescueDraft(ACCOUNT, kept('open-1'));
    await rescueDraft(ACCOUNT, kept('c2', { previousDraftId: undefined }));
    await flushed();
    expect(saveDraftVersion).toHaveBeenCalledTimes(1);
    expect(saveDraftVersion.mock.calls[0][2]).toBeUndefined();
    expect((await rescuedDrafts(ACCOUNT)).map((d) => d.id)).toEqual(['open-1']);
    composerClosed('open-1');
  });
});
