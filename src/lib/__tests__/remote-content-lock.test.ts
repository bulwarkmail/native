import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// External content locked to "block" by the organisation keeps remote
// content out even for trusted senders (webmail hooks/use-third-party-mode.ts
// externalContentLockedToBlock, 84de2395f, 128f61646).

vi.mock('../../api/jmap-client', () => ({
  jmapClient: { serverUrl: null, username: null, usesBearerAuth: false, currentSession: null },
}));
vi.mock('../client-cert', () => ({ fetchWithoutForeignRedirect: vi.fn(), secureFetch: vi.fn() }));
vi.mock('../../stores/auth-store', async () => {
  const { create } = await import('zustand');
  return { useAuthStore: create(() => ({ activeAccountId: null as string | null, session: null as unknown })) };
});

import { usePolicyStore } from '../../stores/policy-store';
import { useAccountStore, type AccountEntry } from '../../stores/account-store';
import { sanitizePolicy, type OrgPolicy } from '../org-policy';
import { shouldBlockEditorRemoteImages } from '../editor-html';
import {
  externalContentLockedToBlock,
  readerBlocksRemoteContent,
  remoteContentBlockedByOrg,
} from '../remote-content-lock';

const WEBMAIL = 'https://webmail.example.org';
const ADA = 'ada@example.com@mail.example.com';
const BOB = 'bob@other.org@mail.other.org';

function account(id: string, email: string, webmailUrl: string): AccountEntry {
  return {
    id, serverUrl: 'https://mail.example.com', username: email, displayName: email, email, avatarColor: '#000',
    lastLoginAt: 1, isConnected: true, hasError: false, isDefault: false, webmailUrl,
  };
}

const policy = (restrictions: Record<string, unknown>, defaults: Record<string, unknown> = {}): OrgPolicy =>
  sanitizePolicy({ restrictions, defaults, features: {}, themePolicy: {} })!;

/** The active account with this effective policy and a known config. */
function withPolicy(effective: OrgPolicy | null) {
  usePolicyStore.setState({ accountId: ADA, effective, links: {}, configPending: false, byAccount: {} });
}

/** What the reader decides for a trusted sender with the setting at `setting`. */
function readerBlocksTrusted(setting: string): boolean {
  return readerBlocksRemoteContent({
    blockedByOrg: remoteContentBlockedByOrg(usePolicyStore.getState()),
    trusted: true,
    allowOnce: false,
    externalContentPolicy: setting,
  });
}

beforeEach(() => {
  useAccountStore.setState({
    accounts: [account(ADA, 'ada@example.com', WEBMAIL), account(BOB, 'bob@other.org', WEBMAIL)],
    activeAccountId: ADA,
  });
});

describe('externalContentLockedToBlock', () => {
  it('is on for a lock to block, also through the default, and for block as the only allowed value', () => {
    expect(externalContentLockedToBlock(policy({ externalContentPolicy: { locked: true, value: 'block' } }))).toBe(true);
    expect(externalContentLockedToBlock(policy({ externalContentPolicy: { locked: true } }, { externalContentPolicy: 'block' }))).toBe(true);
    expect(externalContentLockedToBlock(policy({ externalContentPolicy: { allowedValues: ['block'] } }))).toBe(true);
  });

  it('is off for a lock to ask, a lock not set, or ask still allowed', () => {
    expect(externalContentLockedToBlock(policy({ externalContentPolicy: { locked: true, value: 'ask' } }))).toBe(false);
    expect(externalContentLockedToBlock(policy({ externalContentPolicy: { locked: false, value: 'block' } }))).toBe(false);
    expect(externalContentLockedToBlock(policy({ externalContentPolicy: { allowedValues: ['block', 'ask'] } }))).toBe(false);
    expect(externalContentLockedToBlock(null)).toBe(false);
  });
});

describe('the reader with a trusted sender', () => {
  it('blocks remote content while the organisation locks External content to block', () => {
    withPolicy(policy({ externalContentPolicy: { locked: true, value: 'block' } }));
    expect(readerBlocksTrusted('block')).toBe(true);
  });

  it('blocks it when block is the only allowed value', () => {
    withPolicy(policy({ externalContentPolicy: { allowedValues: ['block'] } }));
    expect(readerBlocksTrusted('block')).toBe(true);
  });

  it('lets trust load it with the setting locked to ask', () => {
    withPolicy(policy({ externalContentPolicy: { locked: true, value: 'ask' } }));
    expect(readerBlocksTrusted('ask')).toBe(false);
  });

  it('reads the lock from the message account\'s own policy', () => {
    withPolicy(null);
    usePolicyStore.setState({
      byAccount: {
        [BOB]: {
          policy: policy({ externalContentPolicy: { locked: true, value: 'block' } }),
          partial: false, fetchedAt: 1, webmailUrl: WEBMAIL,
        },
      },
    });
    expect(remoteContentBlockedByOrg(usePolicyStore.getState())).toBe(false);
    expect(remoteContentBlockedByOrg(usePolicyStore.getState(), BOB)).toBe(true);
  });
});

describe('a reply\'s quote', () => {
  it('stays blocked for a trusted sender while the organisation locks block', () => {
    withPolicy(policy({ externalContentPolicy: { locked: true, value: 'block' } }));
    const blockedByOrg = remoteContentBlockedByOrg(usePolicyStore.getState());
    expect(shouldBlockEditorRemoteImages({
      seedHtml: '<img src="https://tracker.example/p.gif">',
      isDraft: false,
      externalContentPolicy: blockedByOrg ? 'block' : 'allow',
      senderTrusted: !blockedByOrg,
    })).toBe(true);
  });
});

describe('wiring', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

  it('the reader and the composer read the organisation lock, not only no-third-party traffic', () => {
    expect(read('components/EmailBodyView.tsx')).toMatch(/const remoteBlockedByOrg = useRemoteContentBlockedByOrg\(\);/);
    expect(read('components/EmailBodyView.tsx')).toMatch(/readerBlocksRemoteContent\(\{ blockedByOrg: remoteBlockedByOrg, trusted, allowOnce, externalContentPolicy \}\)/);
    const compose = read('screens/ComposeScreen.tsx');
    expect(compose).toMatch(/const remoteBlockedByOrg = useRemoteContentBlockedByOrg\(\);/);
    // Replying adds no trusted senders while the organisation blocks remote content.
    expect(compose).toMatch(/if \(isReplyLike && mode !== 'forward' && !remoteContentBlockedByOrg\(usePolicyStore\.getState\(\)\)\) \{/);
  });
});
