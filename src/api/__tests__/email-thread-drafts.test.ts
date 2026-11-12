import { describe, it, expect, vi, beforeEach } from 'vitest';

// Reply on a message reopens its saved reply. A reply draft moved to Trash
// keeps its $draft keyword and stays in the conversation; it must not be
// the one that reopens.

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    getMaxObjectsInGet: vi.fn(() => 500),
    getMaxObjectsInSet: vi.fn(() => 500),
  },
}));

import { jmapClient } from '../jmap-client';
import { getThreadDrafts } from '../email';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

const draft = (id: string, mailbox: string) => ({ id, threadId: 't1', keywords: { $draft: true }, mailboxIds: { [mailbox]: true } });

function answer(roles: { drafts?: string[]; trash?: string[]; junk?: string[] }, refused: string[] = []) {
  const query = (callId: string, ids: string[] | undefined) => (refused.includes(callId)
    ? ['error', { type: 'unsupportedFilter' }, callId]
    : ['Mailbox/query', { ids: ids ?? [] }, callId]);
  mockRequest.mockResolvedValue({
    methodResponses: [
      ['Thread/get', { list: [{ id: 't1', emailIds: ['orig', 'kept', 'binned', 'spam'] }] }, 't'],
      ['Email/get', {
        list: [
          { id: 'orig', threadId: 't1', keywords: { $seen: true }, mailboxIds: { inbox: true } },
          draft('kept', 'drafts'),
          draft('binned', 'trash'),
          draft('spam', 'junk'),
        ],
      }, 'e'],
      query('d', roles.drafts),
      query('x', roles.trash),
      query('j', roles.junk),
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getThreadDrafts', () => {
  it('keeps only the drafts in the Drafts folder, not one moved to Trash or Junk', async () => {
    answer({ drafts: ['drafts'], trash: ['trash'], junk: ['junk'] });

    const drafts = await getThreadDrafts('t1');

    expect(drafts.map((d) => d.id)).toEqual(['kept']);
    const calls = mockRequest.mock.calls[0][0] as Array<[string, Record<string, unknown>, string]>;
    expect(calls.filter(([name]) => name === 'Mailbox/query').map(([, args]) => args.filter))
      .toEqual([{ role: 'drafts' }, { role: 'trash' }, { role: 'junk' }]);
  });

  it('keeps every draft outside Trash and Junk in an account without a Drafts folder', async () => {
    answer({ drafts: [], trash: ['trash'], junk: ['junk'] });

    expect((await getThreadDrafts('t1')).map((d) => d.id)).toEqual(['kept']);
  });

  it('hides no draft when the server refuses the folder lookups', async () => {
    answer({}, ['d', 'x', 'j']);

    expect((await getThreadDrafts('t1')).map((d) => d.id)).toEqual(['kept', 'binned', 'spam']);
  });
});
