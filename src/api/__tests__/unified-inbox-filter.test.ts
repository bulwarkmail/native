import { describe, it, expect, vi } from 'vitest';

vi.mock('../jmap-client', () => ({ jmapClient: {} }));

import { buildFilter } from '../unified-inbox';
import type { Mailbox } from '../types';

const inbox = { id: 'inbox', role: 'inbox', name: 'Inbox' } as Mailbox;

describe('unified inbox search filter', () => {
  it('sends the typed words with no wildcard', () => {
    expect(buildFilter([inbox], { role: 'inbox', query: '  runn  fast ' } as never)).toEqual({
      operator: 'AND',
      conditions: [{ inMailbox: 'inbox' }, { text: 'runn  fast' }],
    });
  });
});
