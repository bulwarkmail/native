import { describe, it, expect } from 'vitest';
import type { Email } from '../../api/types';
import { replyComposeParams } from '../reply-compose';

const source = {
  id: 'm1',
  threadId: 't1',
  mailboxIds: {},
  keywords: {},
  size: 1,
  receivedAt: '2026-10-14T10:00:00Z',
  subject: 'Hello',
  from: [{ name: 'Petra', email: 'petra@example.net' }],
  textBody: [{ partId: '1', type: 'text/plain' }],
  bodyValues: { 1: { value: 'Please confirm.' } },
} as unknown as Email;

describe('replyComposeParams', () => {
  it('carries the text typed in quick reply into the composer', () => {
    const params = replyComposeParams('reply', source, undefined, 'Got it, thanks!');
    expect(params?.prefillBody).toBe('Got it, thanks!');
    expect(params?.replyTo?.from.email).toBe('petra@example.net');
  });

  it('adds nothing when nothing was typed', () => {
    expect(replyComposeParams('reply', source)?.prefillBody).toBeUndefined();
    expect(replyComposeParams('reply', source, undefined, '   ')?.prefillBody).toBeUndefined();
  });
});
