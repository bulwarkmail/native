import { describe, it, expect } from 'vitest';
import { replyComposeParams } from '../reply-compose';
import type { Email } from '../../api/types';

const source = (results: string) => ({
  id: 'e1',
  from: [{ email: 'ceo@bank.example' }],
  replyTo: [{ email: 'pay@evil.example' }],
  subject: 'Invoice',
  headers: [{ name: 'Authentication-Results', value: results }],
  messageId: ['m1@bank.example'],
}) as unknown as Email;
const forged = source('mx; spf=fail smtp.mailfrom=evil.example; dmarc=fail header.from=bank.example');
const verified = source('mx; spf=pass smtp.mailfrom=bank.example; dmarc=pass header.from=bank.example');

describe('replyComposeParams', () => {
  it('hands the composer a forged message\'s sender as untrusted, in every mode', () => {
    for (const mode of ['reply', 'replyAll', 'forward'] as const) {
      const ctx = replyComposeParams(mode, forged, 'j1', 'mx')?.replyTo;
      expect(ctx?.untrustedAddresses).toEqual(['ceo@bank.example', 'pay@evil.example']);
      expect(ctx?.senderAuthenticated).toBe(false);
    }
  });

  it('flags nobody on a verified message, and says it passed', () => {
    const ctx = replyComposeParams('reply', verified, 'j1', 'mx')?.replyTo;
    expect(ctx?.untrustedAddresses).toEqual([]);
    expect(ctx?.senderAuthenticated).toBe(true);
  });

  it('judges by the owning server only', () => {
    const ctx = replyComposeParams('reply', verified, 'j1', null)?.replyTo;
    expect(ctx?.senderAuthenticated).toBe(false);
    expect(ctx?.untrustedAddresses).toEqual(['ceo@bank.example', 'pay@evil.example']);
  });
});
