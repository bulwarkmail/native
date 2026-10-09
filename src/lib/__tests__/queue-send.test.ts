import { beforeEach, describe, expect, it, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  attachmentsUploaded, hasQueueAccounts, buildQueuedSend, shouldQueueSend, queuedEntryFor, findAlreadyQueued, ownerStillActive, OutboxCheckError, quickReplyOwnerActive,
} from '../queue-send';
import type { OutgoingEmail } from '../../api/email';
import { overrideEnvelope, pickSubmissionIdentity } from '../envelope-sender';
import { useSendQueueStore, type QueuedSend } from '../../stores/send-queue-store';

const outgoing: OutgoingEmail = {
  from: [{ email: 'a@x.test' }],
  to: [{ email: 'b@x.test' }],
  subject: 's',
  textBody: 'hi',
  messageId: 'mid-1@x.test',
};

describe('buildQueuedSend', () => {
  it('carries the owner account, identity, ids, absolute sendAt and replyTo', () => {
    const at = new Date('2026-11-01T10:00:00.000Z');
    const e = buildQueuedSend({
      id: 'abc-123', appAccountId: 'owner-app', jmapAccountId: 'owner-jmap', identityId: 'id1',
      outgoing, draftId: 'd1', scheduledAt: at,
      replyTo: { emailIds: ['e1'], keyword: '$answered' },
      now: new Date('2026-10-04T00:00:00.000Z'),
    });
    expect(e).toMatchObject({
      id: 'abc-123', appAccountId: 'owner-app', jmapAccountId: 'owner-jmap', identityId: 'id1',
      draftId: 'd1', sendAt: '2026-11-01T10:00:00.000Z', state: 'queued',
      replyTo: { emailIds: ['e1'], keyword: '$answered' },
      createdAt: '2026-10-04T00:00:00.000Z',
    });
    expect(e.outgoing.messageId).toBe('mid-1@x.test');
    expect(e).not.toHaveProperty('holdFor');
  });

  it('carries the untrusted addresses on a queued reply', () => {
    const p = { id: 'x', appAccountId: 'a', jmapAccountId: 'j', identityId: 'i', outgoing };
    expect(buildQueuedSend({ ...p, replyTo: { emailIds: ['e1'], keyword: '$answered', untrusted: ['ceo@bank.example'] } }).replyTo?.untrusted)
      .toEqual(['ceo@bank.example']);
  });

  it('omits sendAt, draftId and replyTo when absent', () => {
    const e = buildQueuedSend({ id: 'x', appAccountId: 'a', jmapAccountId: 'j', identityId: 'i', outgoing, draftId: null });
    expect(e).not.toHaveProperty('sendAt');
    expect(e).not.toHaveProperty('draftId');
    expect(e).not.toHaveProperty('replyTo');
  });

  it('keeps a From override\'s MAIL FROM, its fallback and the identity that submits it (#1009)', () => {
    const identities = [
      { id: 'main', name: 'Me', email: 'a@x.test', mayDelete: false },
      { id: 'info', name: 'Info', email: 'info@x.test', mayDelete: true },
    ];
    const submitter = pickSubmissionIdentity(identities, identities[0], 'alias@x.test');
    const e = buildQueuedSend({
      id: 'x', appAccountId: 'a', jmapAccountId: 'j', identityId: submitter.id, draftId: null,
      outgoing: { ...outgoing, from: [{ email: 'alias@x.test' }], ...overrideEnvelope(identities, identities[0], 'alias@x.test') },
    });
    expect(e.identityId).toBe('main');
    expect(e.outgoing).toMatchObject({ envelopeMailFrom: 'alias@x.test', envelopeFallbackMailFrom: 'a@x.test' });
    // An override some identity owns is submitted through that identity.
    expect(pickSubmissionIdentity(identities, identities[0], 'INFO@x.test').id).toBe('info');
  });
});

describe('shouldQueueSend', () => {
  it('is true only when offline with uploads done', () => {
    expect(shouldQueueSend({ online: false, uploadsDone: true })).toBe(true);
    expect(shouldQueueSend({ online: true, uploadsDone: true })).toBe(false);
    expect(shouldQueueSend({ online: false, uploadsDone: false })).toBe(false);
  });
  it('attachmentsUploaded requires blob ids', () => {
    expect(attachmentsUploaded(outgoing)).toBe(true);
    expect(attachmentsUploaded({ ...outgoing, attachments: [{ blobId: '', type: 't', name: 'n', size: 1 } as never] })).toBe(false);
  });
});

describe('account guards', () => {
  it('hasQueueAccounts refuses an empty account', () => {
    expect(hasQueueAccounts('a', 'j')).toBe(true);
    expect(hasQueueAccounts('a', '')).toBe(false);
    expect(hasQueueAccounts(null, 'j')).toBe(false);
    expect(hasQueueAccounts('a', undefined)).toBe(false);
  });
  it('buildQueuedSend carries replyTo.jmapAccountId', () => {
    const e = buildQueuedSend({
      id: 'x', appAccountId: 'a', jmapAccountId: 'j', identityId: 'i', outgoing,
      replyTo: { emailIds: ['e1'], keyword: '$forwarded', jmapAccountId: 'orig-j' },
    });
    expect(e.replyTo).toEqual({ emailIds: ['e1'], keyword: '$forwarded', jmapAccountId: 'orig-j' });
  });
});

describe('already-queued guard', () => {
  const queued = (over: Partial<QueuedSend> = {}): QueuedSend => ({
    id: 'q1', appAccountId: 'a', jmapAccountId: 'j', identityId: 'i', outgoing,
    messageId: 'mid-1@x.test', draftId: 'D', createdAt: '2026-10-04T00:00:00.000Z', state: 'queued', ...over,
  });

  it('refuses on a matching Message-ID, brackets and case of the brackets aside', () => {
    expect(queuedEntryFor([queued()], { messageId: '<mid-1@x.test>', draftId: null })?.id).toBe('q1');
    expect(queuedEntryFor([queued({ draftId: undefined })], { messageId: 'mid-1@x.test' })?.id).toBe('q1');
  });

  it('refuses on a matching draft id', () => {
    expect(queuedEntryFor([queued({ messageId: 'other@x.test' })], { messageId: 'new@x.test', draftId: 'D' })?.id).toBe('q1');
  });

  it('refuses whatever the entry state is', () => {
    for (const state of ['sending', 'uncertain', 'failed'] as const) {
      expect(queuedEntryFor([queued({ state })], { messageId: 'mid-1@x.test' })).toBeDefined();
    }
  });

  it('allows a message that is not queued, and never matches on empty refs', () => {
    expect(queuedEntryFor([queued()], { messageId: 'new@x.test', draftId: 'E' })).toBeUndefined();
    expect(queuedEntryFor([queued({ draftId: undefined })], { messageId: null, draftId: null })).toBeUndefined();
    expect(queuedEntryFor([queued({ draftId: undefined })], { messageId: '', draftId: '' })).toBeUndefined();
  });

  describe('findAlreadyQueued', () => {
    beforeEach(async () => {
      await useSendQueueStore.getState().clearAccount('a');
      await AsyncStorage.clear();
    });

    it('hydrates the owner account first, so a row from an earlier run counts', async () => {
      await AsyncStorage.setItem('webmail:sendqueue:v1:a:q1', JSON.stringify(queued()));
      expect(useSendQueueStore.getState().hydrated.a).toBeFalsy();
      const hit = await findAlreadyQueued('a', { messageId: 'mid-1@x.test', draftId: null });
      expect(hit?.id).toBe('q1');
      expect(useSendQueueStore.getState().hydrated.a).toBe(true);
      expect(await findAlreadyQueued('a', { messageId: 'x@y', draftId: 'D' })).toBeDefined();
      expect(await findAlreadyQueued('a', { messageId: 'x@y', draftId: 'E' })).toBeUndefined();
    });

    it('refuses rather than guesses when the owner queue cannot be read', async () => {
      const spy = vi.spyOn(AsyncStorage, 'getAllKeys').mockRejectedValueOnce(new Error('disk'));
      await expect(findAlreadyQueued('a', { messageId: 'mid-1@x.test', draftId: null }))
        .rejects.toBeInstanceOf(OutboxCheckError);
      spy.mockRestore();
    });
  });
});

describe('ownerStillActive (quick reply owner)', () => {
  it('is true only while the account captured at mount is the active one', () => {
    expect(ownerStillActive('a', 'a')).toBe(true);
    expect(ownerStillActive('a', 'b')).toBe(false);
    expect(ownerStillActive('a', null)).toBe(false);
    expect(ownerStillActive(null, null)).toBe(false);
    expect(ownerStillActive(undefined, 'a')).toBe(false);
  });
});

describe('quickReplyOwnerActive', () => {
  it('needs the owner to be both the active account and the one shown', () => {
    expect(quickReplyOwnerActive('a', 'a', 'a')).toBe(true);
    // a switch to b has started: the app shows b, the client is still on a
    expect(quickReplyOwnerActive('a', 'a', 'b')).toBe(false);
    // the switch landed: the box (remounted) still belongs to a's message
    expect(quickReplyOwnerActive('a', 'b', 'b')).toBe(false);
    expect(quickReplyOwnerActive(undefined, 'a', 'a')).toBe(false);
  });
});
