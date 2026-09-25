import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stalwart's change ids only grow. An upgrade that keeps the old change log
// but restarts the counters lower (1.0 counts per collection group where 0.16
// counted per account) would accept an old state and answer with a lower
// newState and no changes: the delta sync would skip everything since. The
// app persists these states, so it reads such an answer like
// cannotCalculateChanges and fetches in full.

const { STALWART_ACCOUNTS } = vi.hoisted(() => ({ STALWART_ACCOUNTS: new Set<string>() }));

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'f',
    request: vi.fn(),
    // Stalwart lists urn:stalwart:jmap in every account's capabilities, the
    // user's own and shared ones, on 0.16.6 through 1.0.
    hasAccountCapability: vi.fn((urn: string, accountId?: string) =>
      urn === 'urn:stalwart:jmap' && STALWART_ACCOUNTS.has(accountId ?? 'f')),
  },
}));

import { jmapClient } from '../jmap-client';
import { getEmailChanges, getEmailListDelta, getEmailQueryChanges, getMailboxChanges } from '../email';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

// Captured from the stw10 test servers for userc: the account's state on
// 0.16.23 (change id 242) and on 1.0 (46).
const STATE_0_16 = 's1iaq';
const STATE_1_0 = 'sfy';

// Exactly how both versions answer a /changes call.
function changes(method: string, oldState: string, newState: string, accountId = 'f') {
  return {
    methodResponses: [[method, {
      accountId, oldState, newState, hasMoreChanges: false, created: [], updated: [], destroyed: [],
    }, '0']],
  };
}

function queryChanges(oldQueryState: string, newQueryState: string) {
  return {
    methodResponses: [['Email/queryChanges', {
      accountId: 'f', oldQueryState, newQueryState, total: 3, removed: [], added: [],
    }, '0']],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  STALWART_ACCOUNTS.clear();
  STALWART_ACCOUNTS.add('f');
});

describe('changes whose state went back on Stalwart', () => {
  it('reads Mailbox/changes answered with a 1.0 state below the 0.16.23 one as not computable', async () => {
    mockRequest.mockResolvedValue(changes('Mailbox/changes', STATE_0_16, STATE_1_0));
    expect(await getMailboxChanges(STATE_0_16)).toBeNull();
  });

  it('reads Email/changes answered with a lower state as not computable', async () => {
    mockRequest.mockResolvedValue(changes('Email/changes', STATE_0_16, STATE_1_0));
    expect(await getEmailChanges(STATE_0_16)).toBeNull();
  });

  it('reads Email/queryChanges answered with a lower query state as not computable', async () => {
    mockRequest.mockResolvedValue(queryChanges(STATE_0_16, STATE_1_0));
    expect(await getEmailQueryChanges('a', STATE_0_16)).toBeNull();
  });

  it('drops both halves of a list delta whose states went back', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [
        ['Email/queryChanges', { accountId: 'f', oldQueryState: STATE_0_16, newQueryState: STATE_1_0, total: 3, removed: [], added: [] }, 'qc'],
        ['Email/changes', { accountId: 'f', oldState: STATE_0_16, newState: STATE_1_0, hasMoreChanges: false, created: [], updated: [], destroyed: [] }, 'ch'],
        ['Email/get', { accountId: 'f', state: STATE_1_0, list: [], notFound: [] }, 'get'],
      ],
    });

    const delta = await getEmailListDelta('a', STATE_0_16, STATE_0_16);

    expect(delta.queryChanges).toBeNull();
    expect(delta.changes).toBeNull();
  });

  it('judges each half of a list delta on its own', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [
        ['Email/queryChanges', { accountId: 'f', oldQueryState: 'sae', newQueryState: 'sai', total: 3, removed: [], added: [] }, 'qc'],
        ['Email/changes', { accountId: 'f', oldState: STATE_0_16, newState: STATE_1_0, hasMoreChanges: false, created: [], updated: [], destroyed: [] }, 'ch'],
        ['Email/get', { accountId: 'f', state: 'sai', list: [], notFound: [] }, 'get'],
      ],
    });

    const delta = await getEmailListDelta('a', 'sae', STATE_0_16);

    expect(delta.queryChanges).toMatchObject({ newQueryState: 'sai' });
    expect(delta.changes).toBeNull();
  });

  it('guards a shared account too, against that account\'s capabilities', async () => {
    STALWART_ACCOUNTS.add('c');
    mockRequest.mockResolvedValue(changes('Email/changes', 'sba', 'sau', 'c'));

    expect(await getEmailChanges('sba', undefined, 'c')).toBeNull();
    expect(jmapClient.hasAccountCapability).toHaveBeenCalledWith('urn:stalwart:jmap', 'c');
  });
});

describe('changes that move on as usual', () => {
  it('keeps a delta whose state went up (Stalwart 0.16.23 and 1.0)', async () => {
    mockRequest.mockResolvedValue(changes('Mailbox/changes', STATE_1_0, STATE_0_16));
    expect(await getMailboxChanges(STATE_1_0)).toMatchObject({ oldState: STATE_1_0, newState: STATE_0_16 });

    mockRequest.mockResolvedValue(changes('Email/changes', STATE_1_0, STATE_1_0));
    expect(await getEmailChanges(STATE_1_0)).toMatchObject({ newState: STATE_1_0 });
  });

  it('keeps the first round of a delta cut short by maxChanges', async () => {
    // An intermediate `r` state is not a change id; it is never compared.
    mockRequest.mockResolvedValue({
      methodResponses: [['Email/changes', {
        accountId: 'f', oldState: STATE_0_16, newState: 'rae2aaaa', hasMoreChanges: true, created: ['x'], updated: [], destroyed: [],
      }, '0']],
    });
    expect(await getEmailChanges(STATE_0_16, 1)).toMatchObject({ newState: 'rae2aaaa', hasMoreChanges: true });
  });

  it('does not read the states of servers other than Stalwart', async () => {
    STALWART_ACCOUNTS.clear();
    mockRequest.mockResolvedValue(changes('Email/changes', STATE_0_16, STATE_1_0));
    expect(await getEmailChanges(STATE_0_16)).toMatchObject({ newState: STATE_1_0 });

    mockRequest.mockResolvedValue(queryChanges(STATE_0_16, STATE_1_0));
    expect(await getEmailQueryChanges('a', STATE_0_16)).toMatchObject({ newQueryState: STATE_1_0 });
  });

  it('still reads cannotCalculateChanges as not computable', async () => {
    // What both versions answer for a state their change log doesn't hold.
    mockRequest.mockResolvedValue({
      methodResponses: [['error', {
        type: 'cannotCalculateChanges',
        description: 'The server cannot calculate the changes between the old and new states.',
      }, '0']],
    });
    expect(await getMailboxChanges('s33333333333333yb')).toBeNull();
  });
});
