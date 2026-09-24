import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    getMaxObjectsInSet: vi.fn(() => 500),
  },
}));

// blob.ts pulls in expo-file-system; the receipt only needs the byte upload.
const uploadBytes = vi.fn(async (..._args: unknown[]) => ({ blobId: 'blob-1', size: 1, type: 'message/rfc822' }));
vi.mock('../blob', () => ({
  uploadBytes: (...args: unknown[]) => uploadBytes(...args),
}));

import { jmapClient } from '../jmap-client';
import { sendReadReceipt } from '../email';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

type Call = [string, Record<string, any>, string];

/** Answer each JMAP method with the given handler; records every call. */
function serve(handlers: Record<string, (args: Record<string, any>) => unknown>) {
  const calls: Call[] = [];
  mockRequest.mockImplementation(async (methodCalls: Call[]) => {
    calls.push(...methodCalls);
    return {
      methodResponses: methodCalls.map(([name, args, id]) => {
        const handler = handlers[name];
        if (!handler) throw new Error(`unexpected ${name}`);
        const result = handler(args);
        return (Array.isArray(result) ? [...result, id] : [name, result, id]) as unknown;
      }),
    };
  });
  return calls;
}

const opts = {
  to: 'sender@remote.example',
  fromEmail: 'me@x.example',
  identityId: 'ident-1',
  sentMailboxId: 'sent-1',
  originalSubject: 'Hello',
  automatic: true,
};

const imported = () => ({ created: { 'import-0': { id: 'mdn-email-1' } } });
const destroyed = (args: Record<string, any>) => ({ destroyed: args.destroy });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sendReadReceipt', () => {
  it('imports the receipt into Sent and submits it', async () => {
    const calls = serve({
      'Email/import': imported,
      'EmailSubmission/set': () => ({ created: { mdn: { id: 'sub-1' } } }),
      'Email/set': destroyed,
    });

    await expect(sendReadReceipt(opts)).resolves.toBe('mdn-email-1');

    expect(calls.map((c) => c[0])).toEqual(['Email/import', 'EmailSubmission/set']);
    expect(calls[0][1].emails['import-0']).toMatchObject({ blobId: 'blob-1', mailboxIds: { 'sent-1': true } });
    expect(calls[1][1].create.mdn).toMatchObject({
      emailId: 'mdn-email-1',
      identityId: 'ident-1',
      envelope: { mailFrom: { email: 'me@x.example' }, rcptTo: [{ email: 'sender@remote.example' }] },
    });
  });

  it('uploads a receipt whose headers a CRLF in the original subject cannot extend', async () => {
    serve({
      'Email/import': imported,
      'EmailSubmission/set': () => ({ created: { mdn: { id: 'sub-1' } } }),
    });

    await sendReadReceipt({
      ...opts,
      subject: 'Read: Contract update\r\nX-Injected: yes\r\nReply-To: attacker@evil.example',
    });

    const raw = new TextDecoder().decode(uploadBytes.mock.calls[0][0] as Uint8Array);
    expect(raw).not.toMatch(/^X-Injected:/m);
    expect(raw).not.toMatch(/^Reply-To:/m);
    expect(raw).toContain('Subject: Read: Contract update X-Injected: yes Reply-To: attacker@evil.example\r\n');
  });

  it('destroys the imported copy when the server refuses the submission', async () => {
    const calls = serve({
      'Email/import': imported,
      'EmailSubmission/set': () => ({
        notCreated: { mdn: { type: 'invalidRecipients', description: 'No valid recipients' } },
      }),
      'Email/set': destroyed,
    });

    await expect(sendReadReceipt({ ...opts, accountId: 'grp-1' })).rejects.toThrow(/No valid recipients/);

    const destroy = calls.find((c) => c[0] === 'Email/set');
    expect(destroy?.[1]).toEqual({ accountId: 'grp-1', destroy: ['mdn-email-1'] });
  });

  it('destroys the imported copy when the submission call errors', async () => {
    const calls = serve({
      'Email/import': imported,
      'EmailSubmission/set': () => ['error', { type: 'forbiddenFrom', description: 'Not allowed' }],
      'Email/set': destroyed,
    });

    await expect(sendReadReceipt(opts)).rejects.toThrow(/Not allowed/);
    expect(calls.find((c) => c[0] === 'Email/set')?.[1]).toEqual({ accountId: 'acc-1', destroy: ['mdn-email-1'] });
  });

  it('destroys the imported copy when the submission request fails in transit', async () => {
    const calls: Call[] = [];
    mockRequest.mockImplementation(async (methodCalls: Call[]) => {
      calls.push(...methodCalls);
      const [name, args, id] = methodCalls[0];
      if (name === 'Email/import') return { methodResponses: [[name, imported(), id]] };
      if (name === 'EmailSubmission/set') throw new Error('Network request failed');
      return { methodResponses: [[name, destroyed(args), id]] };
    });

    await expect(sendReadReceipt(opts)).rejects.toThrow('Network request failed');
    expect(calls.map((c) => c[0])).toEqual(['Email/import', 'EmailSubmission/set', 'Email/set']);
  });

  it('still reports the submission error when the cleanup fails too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    serve({
      'Email/import': imported,
      'EmailSubmission/set': () => ({ notCreated: { mdn: { type: 'forbiddenToSend' } } }),
      'Email/set': () => ({ notDestroyed: { 'mdn-email-1': { type: 'forbidden' } } }),
    });

    await expect(sendReadReceipt(opts)).rejects.toThrow(/forbiddenToSend/);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not submit or destroy anything when the import fails', async () => {
    const calls = serve({
      'Email/import': () => ({ notCreated: { 'import-0': { type: 'overQuota' } } }),
    });

    await expect(sendReadReceipt(opts)).rejects.toThrow(/overQuota/);
    expect(calls.map((c) => c[0])).toEqual(['Email/import']);
  });
});
