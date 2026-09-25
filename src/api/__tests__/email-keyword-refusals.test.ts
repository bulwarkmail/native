import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stalwart refuses a keyword per message in Email/set `notUpdated`, not as a
// request error. 1.0 refuses keywords over 128 bytes and more than 100
// keywords on one message; 0.16 accepts both (it cuts long keywords to 128
// characters); a read-only shared folder refuses any on both.

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'f',
    request: vi.fn(),
    getMaxObjectsInGet: vi.fn(() => 500),
    getMaxObjectsInSet: vi.fn(() => 500),
  },
}));

import { jmapClient } from '../jmap-client';
import { markMailboxAsRead, markMailboxesAsRead, patchKeywordsForEmails } from '../email';
import { failedIdsOf, isJMAPSetError, JMAPSetError } from '../jmap-result';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;
const mockMaxInSet = jmapClient.getMaxObjectsInSet as ReturnType<typeof vi.fn>;

// Exactly what Stalwart 1.0 answers (webmail d7004b38 captured these).
const TOO_LONG = {
  type: 'invalidProperties',
  description: 'Keywords cannot be longer than 128 bytes.',
  properties: ['keywords'],
};
const TOO_MANY = {
  type: 'tooManyKeywords',
  description: 'An email cannot have more than 100 keywords.',
  properties: ['keywords'],
};

type Call = [string, Record<string, unknown>, string];

/** Answers each Email/set with `result(ids)` and each Email/query with `query()`. */
function serve(result: (ids: string[]) => Record<string, unknown>, query?: () => string[]) {
  const sent: Call[] = [];
  mockRequest.mockImplementation(async (calls: Call[]) => {
    sent.push(...calls);
    return {
      methodResponses: calls.map(([name, args, id]) => {
        if (name === 'Email/query') return [name, { accountId: 'f', ids: query?.() ?? [] }, id];
        const ids = Object.keys((args.update ?? {}) as Record<string, unknown>);
        return [name, { accountId: 'f', oldState: 'sfy', newState: 'sfz', ...result(ids) }, id];
      }),
    };
  });
  return sent;
}

const refuse = (error: Record<string, unknown>, which: (id: string) => boolean = () => true) => (ids: string[]) => ({
  updated: Object.fromEntries(ids.filter((id) => !which(id)).map((id) => [id, null])),
  notUpdated: Object.fromEntries(ids.filter(which).map((id) => [id, error])),
});
const accept = (ids: string[]) => ({ updated: Object.fromEntries(ids.map((id) => [id, null])) });

beforeEach(() => {
  vi.clearAllMocks();
  mockMaxInSet.mockReturnValue(500);
});

describe('keyword writes report what the server refused', () => {
  it('rejects a tag over 128 bytes with the SetError on Stalwart 1.0', async () => {
    serve(refuse(TOO_LONG));
    const err = await patchKeywordsForEmails(['m1'], { [`$label:${'x'.repeat(130)}`]: true }).catch((e) => e);
    expect(isJMAPSetError(err)).toBe(true);
    expect(err).toMatchObject({ type: 'invalidProperties', properties: ['keywords'] });
    expect((err as Error).message).toContain('Keywords cannot be longer than 128 bytes.');
  });

  it('rejects one keyword too many on Stalwart 1.0', async () => {
    serve(refuse(TOO_MANY));
    await expect(patchKeywordsForEmails(['m1'], { '$label:one-more': true }))
      .rejects.toMatchObject({ type: 'tooManyKeywords' });
  });

  it('resolves when Stalwart 0.16 takes the write', async () => {
    serve(accept);
    await expect(patchKeywordsForEmails(['m1', 'm2'], { $flagged: true })).resolves.toBeUndefined();
  });

  it('writes every batch before reporting a refused message', async () => {
    mockMaxInSet.mockReturnValue(1);
    const sent = serve(refuse(TOO_MANY, (id) => id === 'm1'));

    await expect(patchKeywordsForEmails(['m1', 'm2', 'm3'], { '$label:work': true }))
      .rejects.toThrow(JMAPSetError);

    expect(sent.map(([, args]) => Object.keys(args.update as Record<string, unknown>))).toEqual([['m1'], ['m2'], ['m3']]);
  });

  it('names every refused message across the batches, so callers show only what was written', async () => {
    mockMaxInSet.mockReturnValue(2);
    serve(refuse({ type: 'forbidden' }, (id) => id === 'm1' || id === 'm4'));

    const err = await patchKeywordsForEmails(['m1', 'm2', 'm3', 'm4'], { $seen: true }).catch((e) => e);

    expect(err).toBeInstanceOf(JMAPSetError);
    expect(failedIdsOf(err)).toEqual(['m1', 'm4']);
    // A refused request says nothing about which messages were written.
    expect(failedIdsOf(new Error('Network request failed'))).toBeNull();
  });
});

describe('markMailboxAsRead', () => {
  it('marks what it can and then reports the refused messages (read-only shared folder)', async () => {
    // The refused message stays unread and comes back in the next page.
    const unread = ['m1', 'm2', 'm3'];
    const sent = serve(
      (ids) => {
        const result = refuse({ type: 'forbidden', description: 'You are not allowed to modify this message.' }, (id) => id === 'm2')(ids);
        for (const id of Object.keys(result.updated)) unread.splice(unread.indexOf(id), 1);
        return result;
      },
      () => [...unread],
    );
    mockMaxInSet.mockReturnValue(3);

    const err = await markMailboxAsRead('a').catch((e) => e);

    expect(isJMAPSetError(err)).toBe(true);
    expect(err).toMatchObject({ type: 'forbidden' });
    // Two rounds: m1..m3, then the refused m2 alone, which ends the loop.
    expect(sent.filter(([name]) => name === 'Email/set')).toHaveLength(2);
    expect(unread).toEqual(['m2']);
  });

  it('returns the count when every message is marked (Stalwart 0.16 and 1.0)', async () => {
    const unread = ['m1', 'm2'];
    serve(
      (ids) => {
        for (const id of ids) unread.splice(unread.indexOf(id), 1);
        return accept(ids);
      },
      () => [...unread],
    );

    expect(await markMailboxAsRead('a')).toBe(2);
  });
});

describe('markMailboxesAsRead (a folder and its subfolders)', () => {
  /** Unread messages per folder; `readOnly` folders refuse every update. */
  function serveFolders(unread: Record<string, string[]>, readOnly: string[]) {
    const folderOf = (id: string) => Object.keys(unread).find((f) => unread[f].includes(id))!;
    const sent: Call[] = [];
    mockRequest.mockImplementation(async (calls: Call[]) => {
      sent.push(...calls);
      return {
        methodResponses: calls.map(([name, args, id]) => {
          if (name === 'Email/query') {
            const [inMailbox] = (args.filter as { conditions: Array<{ inMailbox?: string }> }).conditions;
            return [name, { accountId: args.accountId, ids: [...unread[inMailbox.inMailbox!]] }, id];
          }
          const ids = Object.keys(args.update as Record<string, unknown>);
          const refused = ids.filter((m) => readOnly.includes(folderOf(m)));
          for (const m of ids.filter((m) => !refused.includes(m))) unread[folderOf(m)].splice(unread[folderOf(m)].indexOf(m), 1);
          return [name, {
            accountId: args.accountId,
            updated: Object.fromEntries(ids.filter((m) => !refused.includes(m)).map((m) => [m, null])),
            ...(refused.length ? { notUpdated: Object.fromEntries(refused.map((m) => [m, { type: 'forbidden' }])) } : {}),
          }, id];
        }),
      };
    });
    return sent;
  }

  it('marks the folders after one the server refuses, then reports the refusal', async () => {
    const unread = { parent: ['p1'], shared: ['s1'], child: ['c1', 'c2'] };
    serveFolders(unread, ['shared']);

    const err = await markMailboxesAsRead([{ id: 'parent' }, { id: 'shared', accountId: 'b' }, { id: 'child' }])
      .catch((e) => e);

    expect(err).toMatchObject({ type: 'forbidden' });
    expect(unread).toEqual({ parent: [], shared: ['s1'], child: [] });
  });

  it('stops at a lost connection instead of trying every folder', async () => {
    mockRequest.mockRejectedValue(new TypeError('Network request failed'));

    await expect(markMailboxesAsRead([{ id: 'a' }, { id: 'b' }])).rejects.toThrow('Network request failed');

    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('resolves with the count when every folder is marked', async () => {
    serveFolders({ a: ['m1'], b: ['m2', 'm3'] }, []);

    await expect(markMailboxesAsRead([{ id: 'a' }, { id: 'b' }])).resolves.toBe(3);
  });
});
