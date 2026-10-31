import { describe, it, expect, vi } from 'vitest';

vi.mock('../jmap-client', () => ({ jmapClient: { accountId: 'acc-1', request: vi.fn() } }));

import { EMAIL_FULL_PROPERTIES, EMAIL_LIST_PROPERTIES, THREAD_HEADER_PROPERTIES } from '../email';

// Sort by "Date sent" compares sentAt on the device for a list merged from
// several accounts, but list rows never had it, so the order fell back to
// the received date (webmail #1219).
describe('list properties', () => {
  it('include sentAt, once', () => {
    for (const list of [EMAIL_LIST_PROPERTIES, EMAIL_FULL_PROPERTIES, THREAD_HEADER_PROPERTIES]) {
      expect(list.filter((p) => p === 'sentAt')).toHaveLength(1);
    }
  });
});
