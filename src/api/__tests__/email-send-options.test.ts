import { describe, it, expect, vi, beforeEach } from 'vitest';

// The composer's message priority (webmail #970) and the DSN / REQUIRETLS
// submission options (webmail submissionEnvelopeParameters): what the
// Email/set create and the EmailSubmission envelope carry.

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    learnHoldLimit: vi.fn(),
    getSubmissionAccountIds: vi.fn(() => ['acc-1']),
    hasDelayedSend: vi.fn(() => true),
    hasAccountCapability: vi.fn(() => false),
    getMaxCallsInRequest: vi.fn(() => 16),
    getMaxObjectsInGet: vi.fn(() => 500),
    getMaxObjectsInSet: vi.fn(() => 500),
    getAccountCapability: vi.fn(),
  },
}));

import { jmapClient } from '../jmap-client';
import { saveDraftVersion, sendEmail } from '../email';
import { draftContextFromEmail } from '../../lib/draft-context';
import type { Email } from '../types';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

const OUTGOING = {
  from: [{ email: 'me@example.com' }],
  to: [{ email: 'you@example.com' }],
  cc: [{ email: 'cc@example.com' }],
  subject: 'Hello',
  textBody: 'Hi',
};

const SENT = {
  methodResponses: [
    ['Email/set', { created: { draft: { id: 'e-new' } } }, '0'],
    ['EmailSubmission/set', { created: { 'sub-1': { id: 's-1' } } }, '1'],
  ],
};

function sentCalls() {
  const calls = mockRequest.mock.calls[0][0] as Array<[string, Record<string, any>, string]>;
  const create = calls.find(([name]) => name === 'Email/set')![1].create.draft;
  const submission = calls.find(([name]) => name === 'EmailSubmission/set')![1].create['sub-1'];
  return { create, submission };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequest.mockResolvedValue(SENT);
});

describe('message priority', () => {
  it('writes X-Priority and Importance for a high-priority message', async () => {
    await sendEmail({ ...OUTGOING, priority: 'high' }, 'id-1', 'sent', undefined, { draftsMailboxId: 'drafts' });
    const { create } = sentCalls();
    expect(create['header:X-Priority:asText']).toBe('1 (Highest)');
    expect(create['header:Importance:asText']).toBe('high');
  });

  it('writes the low values for a low-priority message', async () => {
    await sendEmail({ ...OUTGOING, priority: 'low' }, 'id-1', 'sent');
    const { create } = sentCalls();
    expect(create['header:X-Priority:asText']).toBe('5 (Lowest)');
    expect(create['header:Importance:asText']).toBe('low');
  });

  it('writes no priority header for a normal message', async () => {
    await sendEmail({ ...OUTGOING, priority: 'normal' }, 'id-1', 'sent');
    const { create } = sentCalls();
    expect(Object.keys(create).some((k) => /Priority|Importance/.test(k))).toBe(false);
  });

  it('saves the priority with a draft, and a re-opened draft reads it back', async () => {
    mockRequest.mockResolvedValueOnce({
      methodResponses: [
        ['Email/set', { created: { draft: { id: 'd-1' } } }, '0'],
        ['Email/get', { list: [] }, '1'],
      ],
    });
    await saveDraftVersion({ ...OUTGOING, priority: 'high' }, 'drafts');
    const create = (mockRequest.mock.calls[0][0] as any[])[0][1].create.draft;
    expect(create['header:X-Priority:asText']).toBe('1 (Highest)');

    const reopened = draftContextFromEmail({
      id: 'd-1',
      headers: [{ name: 'X-Priority', value: ' 1 (Highest)' }, { name: 'Importance', value: ' high' }],
    } as unknown as Email);
    expect(reopened.priority).toBe('high');
  });
});

describe('delivery status notifications and REQUIRETLS', () => {
  it('asks every recipient for a DSN with headers only', async () => {
    await sendEmail(OUTGOING, 'id-1', 'sent', undefined, { draftsMailboxId: 'drafts', requestDsn: true });
    const { submission } = sentCalls();
    expect(submission.envelope).toEqual({
      mailFrom: { email: 'me@example.com', parameters: { RET: 'HDRS' } },
      rcptTo: [
        { email: 'you@example.com', parameters: { NOTIFY: 'SUCCESS,FAILURE,DELAY' } },
        { email: 'cc@example.com', parameters: { NOTIFY: 'SUCCESS,FAILURE,DELAY' } },
      ],
    });
  });

  it('puts REQUIRETLS next to the HOLDFOR of a held send', async () => {
    await sendEmail(OUTGOING, 'id-1', 'sent', 30, { draftsMailboxId: 'drafts', requireTls: true });
    const { submission } = sentCalls();
    expect(submission.envelope.mailFrom.parameters).toEqual({ HOLDFOR: '30', REQUIRETLS: null });
    expect(submission.envelope.rcptTo).toEqual([{ email: 'you@example.com' }, { email: 'cc@example.com' }]);
  });

  it('leaves the envelope to the server without options, hold or From override', async () => {
    await sendEmail(OUTGOING, 'id-1', 'sent', undefined, { draftsMailboxId: 'drafts' });
    expect(sentCalls().submission.envelope).toBeUndefined();
  });
});
