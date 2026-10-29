import { describe, it, expect, vi, beforeEach } from 'vitest';

const { api } = vi.hoisted(() => ({
  api: {
    cancelScheduledSend: vi.fn(async () => undefined),
    restoreEmailToDraft: vi.fn(async () => undefined),
  },
}));
vi.mock('../../api/email', () => api);

import type { Mailbox } from '../../api/types';
import { cancelScheduledToDrafts, scheduledAccountOverride } from '../compose-scheduled';

function mailbox(role: string, id: string, shared?: string): Mailbox {
  return {
    id: shared ? `${shared}:${id}` : id,
    originalId: shared ? id : undefined,
    name: role,
    role,
    accountId: shared,
    isShared: !!shared,
  } as Mailbox;
}

const MAILBOXES = [
  mailbox('drafts', 'own-drafts'),
  mailbox('sent', 'own-sent'),
  mailbox('drafts', 'team-drafts', 'team'),
  mailbox('sent', 'team-sent', 'team'),
];

beforeEach(() => vi.clearAllMocks());

// native #84: "Cancel send" left the message in Sent, where it passed for a
// sent one; like Edit, it now goes back to Drafts.
describe('Cancel send of a scheduled message', () => {
  it('cancels the submission and moves an own message back into the own Drafts', async () => {
    const item = { accountId: 'own', emailSubmissionId: 'sub-1', emailId: 'mail-1' };
    await expect(cancelScheduledToDrafts(item, MAILBOXES, 'own')).resolves.toEqual({ inDrafts: true });
    expect(api.cancelScheduledSend).toHaveBeenCalledWith('sub-1', 'own');
    expect(api.restoreEmailToDraft).toHaveBeenCalledWith('mail-1', 'own-drafts', 'own-sent', 'own');
  });

  it("moves a group account's message back into that account's Drafts", async () => {
    const item = { accountId: 'team', emailSubmissionId: 'sub-1', emailId: 'mail-1' };
    await cancelScheduledToDrafts(item, MAILBOXES, 'own');
    expect(api.cancelScheduledSend).toHaveBeenCalledWith('sub-1', 'team');
    expect(api.restoreEmailToDraft).toHaveBeenCalledWith('mail-1', 'team-drafts', 'team-sent', 'team');
  });

  it('moves nothing when the cancel fails', async () => {
    api.cancelScheduledSend.mockRejectedValueOnce(new Error('already sent'));
    const item = { accountId: 'own', emailSubmissionId: 'sub-1', emailId: 'mail-1' };
    await expect(cancelScheduledToDrafts(item, MAILBOXES, 'own')).rejects.toThrow('already sent');
    expect(api.restoreEmailToDraft).not.toHaveBeenCalled();
  });

  it('says so when the account has no Drafts folder', async () => {
    const item = { accountId: 'own', emailSubmissionId: 'sub-1', emailId: 'mail-1' };
    await expect(cancelScheduledToDrafts(item, [mailbox('sent', 'own-sent')], 'own')).resolves.toEqual({ inDrafts: false });
    expect(api.restoreEmailToDraft).not.toHaveBeenCalled();
  });

  // The cancel went through, so it must not read as "Cancel failed" with the
  // row still listed as scheduled.
  it('reports a cancelled send it could not move back to Drafts, without failing', async () => {
    const moveError = new Error('Network request failed');
    api.restoreEmailToDraft.mockRejectedValueOnce(moveError);
    const item = { accountId: 'own', emailSubmissionId: 'sub-1', emailId: 'mail-1' };
    await expect(cancelScheduledToDrafts(item, MAILBOXES, 'own')).resolves.toEqual({ inDrafts: false, moveError });
  });

  it('names the own account as no override', () => {
    expect(scheduledAccountOverride({ accountId: 'own' }, 'own')).toBeUndefined();
    expect(scheduledAccountOverride({ accountId: 'team' }, 'own')).toBe('team');
  });
});
