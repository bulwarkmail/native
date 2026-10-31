import { describe, it, expect, vi, beforeEach } from 'vitest';

// Sending from the offline queue: a message an unanswered attempt may have
// sent is looked up by its Message-ID first and not sent again when a copy
// went out.

vi.mock('../jmap-client', () => ({
  jmapClient: { accountId: 'acc-1', request: vi.fn(), getAccountCapability: vi.fn(() => undefined) },
}));
const sendEmail = vi.fn(async (..._a: any[]) => ({ scheduled: false, emailId: 'e-new', emailSubmissionId: 's-1' }));
const destroyEmails = vi.fn(async (..._a: any[]) => undefined);
vi.mock('../email', () => ({
  sendEmail: (...a: any[]) => sendEmail(...a),
  destroyEmails: (...a: any[]) => destroyEmails(...a),
}));
vi.mock('../../lib/compose-send-account', () => ({
  sendTargetFor: vi.fn(async (identity: { id: string }) => ({ identityId: identity.id, sentMailboxId: 'sent', draftsMailboxId: 'drafts' })),
}));

import { jmapClient } from '../jmap-client';
import { findCopiesByMessageId, runQueuedSend, wasQueuedSendSent } from '../queued-send';
import { newQueuedSend, type QueuedSendPayload } from '../../lib/send-queue';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

const PAYLOAD = {
  outgoing: { from: [{ email: 'me@x.de' }], to: [{ email: 'you@x.de' }], subject: 'Hi', textBody: 'x', messageId: 'm1@x.de' },
  identity: { id: 'id-1', email: 'me@x.de', name: 'Me' },
  fromEmail: 'me@x.de',
  sentMailboxId: 'sent',
  draftsMailboxId: 'drafts',
  draftId: 'draft-1',
  requestDsn: true,
} as unknown as QueuedSendPayload;

const found = (list: Array<{ id: string; keywords?: Record<string, boolean>; messageId?: string[] }>) => ({
  methodResponses: [
    ['Email/query', { ids: list.map((e) => e.id) }, '0'],
    ['Email/get', { list }, '1'],
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runQueuedSend', () => {
  it('sends a message no attempt reached the server with, without looking first', async () => {
    const outcome = await runQueuedSend(newQueuedSend('q', PAYLOAD, 0, false), []);
    expect(outcome.kind).toBe('sent');
    expect(mockRequest).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledWith(
      PAYLOAD.outgoing, 'id-1', 'sent', undefined,
      // DSN only where the account lists it; this one lists nothing.
      expect.objectContaining({ draftsMailboxId: 'drafts', draftId: 'draft-1', requestDsn: false }),
    );
  });

  it('does not send again a message whose earlier attempt went out, and removes its old draft', async () => {
    mockRequest.mockResolvedValueOnce(found([
      { id: 'draft-1', keywords: { $draft: true }, messageId: ['m1@x.de'] },
      { id: 'sent-1', keywords: { $seen: true }, messageId: ['<m1@x.de>'] },
    ]));
    const outcome = await runQueuedSend(newQueuedSend('q', PAYLOAD, 0, true), []);
    expect(outcome.kind).toBe('alreadySent');
    expect(sendEmail).not.toHaveBeenCalled();
    expect(destroyEmails).toHaveBeenCalledWith(['draft-1'], 'acc-1');
  });

  it('removes a copy a refused attempt left behind, then sends', async () => {
    mockRequest.mockResolvedValueOnce(found([
      { id: 'draft-1', keywords: { $draft: true }, messageId: ['m1@x.de'] },
      { id: 'left-1', keywords: { $draft: true, $seen: true }, messageId: ['m1@x.de'] },
    ]));
    const outcome = await runQueuedSend(newQueuedSend('q', PAYLOAD, 0, true), []);
    expect(outcome.kind).toBe('sent');
    expect(destroyEmails).toHaveBeenCalledWith(['left-1'], 'acc-1');
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('holds a scheduled message for the time that is left', async () => {
    const now = Date.parse('2026-10-31T12:00:00Z');
    await runQueuedSend(newQueuedSend('q', { ...PAYLOAD, scheduledAt: '2026-10-31T13:00:00Z' }, now, false), [], now);
    expect(sendEmail.mock.calls[0][3]).toBe(3600);
  });
});

describe('wasQueuedSendSent', () => {
  it('finds a copy an earlier attempt sent, and removes the old draft', async () => {
    mockRequest.mockResolvedValueOnce(found([
      { id: 'draft-1', keywords: { $draft: true }, messageId: ['m1@x.de'] },
      { id: 'sent-1', keywords: { $seen: true }, messageId: ['m1@x.de'] },
    ]));
    expect(await wasQueuedSendSent(newQueuedSend('q', PAYLOAD, 0, true), [])).toBe(true);
    expect(destroyEmails).toHaveBeenCalledWith(['draft-1'], 'acc-1');
  });

  it('says not sent when only drafts are there, and removes nothing', async () => {
    mockRequest.mockResolvedValueOnce(found([
      { id: 'draft-1', keywords: { $draft: true }, messageId: ['m1@x.de'] },
      { id: 'left-1', keywords: { $draft: true, $seen: true }, messageId: ['m1@x.de'] },
    ]));
    expect(await wasQueuedSendSent(newQueuedSend('q', PAYLOAD, 0, true), [])).toBe(false);
    expect(destroyEmails).not.toHaveBeenCalled();
  });

  it('does not look for a message no attempt reached the server with', async () => {
    expect(await wasQueuedSendSent(newQueuedSend('q', PAYLOAD, 0, false), [])).toBe(false);
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe('findCopiesByMessageId', () => {
  it('reads the recent messages of Sent and Drafts and keeps exact matches only', async () => {
    mockRequest.mockResolvedValueOnce(found([
      { id: 'a', keywords: {}, messageId: ['m1@x.de'] },
      { id: 'b', keywords: {}, messageId: ['other-m1@x.de'] },
      { id: 'c', keywords: {}, messageId: [] },
    ]));
    const copies = await findCopiesByMessageId('<m1@x.de>', { mailboxIds: ['sent', 'drafts'], since: Date.parse('2026-10-31T12:00:00Z') });
    expect(copies.map((c) => c.id)).toEqual(['a']);
    const [query] = mockRequest.mock.calls[0][0];
    // Not the header filter: Stalwart answers that from a lagging index.
    expect(query[1].filter).toEqual({
      operator: 'AND',
      conditions: [
        { after: '2026-10-31T11:50:00.000Z' },
        { operator: 'OR', conditions: [{ inMailbox: 'sent' }, { inMailbox: 'drafts' }] },
      ],
    });
  });
});
