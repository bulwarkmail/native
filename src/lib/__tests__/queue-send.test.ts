import { describe, expect, it } from 'vitest';
import { attachmentsUploaded, buildQueuedSend, shouldQueueSend } from '../queue-send';
import type { OutgoingEmail } from '../../api/email';

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

  it('omits sendAt, draftId and replyTo when absent', () => {
    const e = buildQueuedSend({ id: 'x', appAccountId: 'a', jmapAccountId: 'j', identityId: 'i', outgoing, draftId: null });
    expect(e).not.toHaveProperty('sendAt');
    expect(e).not.toHaveProperty('draftId');
    expect(e).not.toHaveProperty('replyTo');
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
