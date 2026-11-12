import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The unified All Trash couldn't be emptied (webmail mailbox-context-menu
// "Empty" on All Trash and All Junk, 648bbf536, #1540).

const state = vi.hoisted(() => ({
  folders: {} as Record<string, string[]>,
  requests: [] as Array<Array<[string, Record<string, any>, string]>>,
}));

vi.mock('../jmap-client', () => {
  const request = vi.fn(async (calls: Array<[string, Record<string, any>, string]>) => {
    state.requests.push(calls);
    const out: Array<[string, Record<string, any>, string]> = [];
    let lastIds: string[] = [];
    for (const [name, args, callId] of calls) {
      const acc = args.accountId as string;
      if (name === 'Mailbox/get') {
        out.push(['Mailbox/get', { list: [
          { id: `${acc}-in`, role: 'inbox', name: 'Inbox' },
          { id: `${acc}-trash`, role: 'trash', name: 'Trash' },
          { id: `${acc}-junk`, role: 'junk', name: 'Junk' },
        ] }, callId]);
      } else if (name === 'Email/query') {
        const box = args.filter.inMailbox as string;
        lastIds = (state.folders[box] ?? []).slice(0, args.limit);
        out.push(['Email/query', { ids: lastIds }, callId]);
      } else if (name === 'Email/set') {
        const ids = args['#destroy'] ? lastIds : (args.destroy ?? []);
        for (const box of Object.keys(state.folders)) state.folders[box] = state.folders[box].filter((id) => !ids.includes(id));
        out.push(['Email/set', { destroyed: ids }, callId]);
      }
    }
    return { methodResponses: out };
  });
  return {
    jmapClient: {
      isConnected: true,
      accountId: 'own',
      username: 'me',
      serverUrl: 'http://mail.example:8080',
      currentSession: { apiUrl: 'http://mail.example:8080/jmap/', accounts: {} },
      getSharedMailAccounts: () => [{ id: 'grp', name: 'Support' }],
      request,
      getStoredCredentials: vi.fn(async () => null),
    },
    rewriteSessionUrl: (u: string) => u,
    extractOrigin: (u: string) => u,
    parseRetryAfter: () => 0,
    REQUEST_TIMEOUT_MS: 30000,
  };
});

import { emptyUnifiedRole, resetUnifiedCache } from '../unified-inbox';
import { setKnownAccounts } from '../../lib/account-utils';

const LIVE = 'me@mail.example:8080';
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

beforeEach(() => {
  resetUnifiedCache();
  state.requests.length = 0;
  state.folders = {
    'own-trash': ids('t', 1200),
    'own-in': ids('i', 3),
    'own-junk': ids('j', 2),
    'grp-trash': ids('g', 4),
  };
  setKnownAccounts([{ id: LIVE, username: 'me', serverUrl: 'http://mail.example:8080' }]);
});

describe('emptying the unified Trash and Junk', () => {
  it("destroys every message in each covered account's Trash, page by page, and nothing else", async () => {
    const result = await emptyUnifiedRole([LIVE], 'trash');
    expect(result).toEqual({ destroyed: 1200, failed: 0 });
    expect(state.folders['own-trash']).toEqual([]);
    expect(state.folders['own-in']).toHaveLength(3);
    expect(state.folders['own-junk']).toHaveLength(2);
    // The group's Trash only when the view takes group mail in.
    expect(state.folders['grp-trash']).toHaveLength(4);
  });

  it("takes the group accounts' folders in with includeGroup", async () => {
    expect(await emptyUnifiedRole([LIVE], 'trash', { includeGroup: true })).toEqual({ destroyed: 1204, failed: 0 });
    expect(state.folders['grp-trash']).toEqual([]);
    expect(await emptyUnifiedRole([LIVE], 'junk')).toEqual({ destroyed: 2, failed: 0 });
  });

  it('is offered on the All Trash and All Junk views', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../screens/UnifiedInboxScreen.tsx'), 'utf8');
    expect(src).toMatch(/const canEmpty = !view && \(role === 'trash' \|\| role === 'junk'\) && emails\.length > 0;/);
    expect(src).toMatch(/emptyUnifiedRole\(accountIds, emptied, \{ includeGroup \}\)/);
  });
});
