import { describe, it, expect } from 'vitest';
import { folderIconPrunePlan } from '../folder-icon-prune';

const shown = (over: Partial<Parameters<typeof folderIconPrunePlan>[1]> = {}) => ({
  accountId: 'appA',
  mailboxState: 's1',
  synced: true,
  ownIds: ['inbox', 'a'],
  ...over,
});

describe('folderIconPrunePlan', () => {
  it('prunes from a server-confirmed own list', () => {
    expect(folderIconPrunePlan(null, shown())).toEqual({ key: 'appA|s1', accountId: 'appA', liveIds: ['inbox', 'a'] });
  });

  it('does not prune again for a list with the same state token (a shared-folder update without the new folder)', () => {
    const first = folderIconPrunePlan(null, shown())!;
    expect(folderIconPrunePlan(first.key, shown({ ownIds: ['inbox'] }))).toBeNull();
  });

  it('prunes again once the own state token changes', () => {
    expect(folderIconPrunePlan('appA|s1', shown({ mailboxState: 's2', ownIds: ['inbox'] }))?.liveIds).toEqual(['inbox']);
  });

  it('never prunes from a cached list at cold start, before the folders were read this session', () => {
    expect(folderIconPrunePlan(null, shown({ synced: false }))).toBeNull();
  });

  it('does not prune without an account, a state token or any own folder', () => {
    expect(folderIconPrunePlan(null, shown({ accountId: null }))).toBeNull();
    expect(folderIconPrunePlan(null, shown({ mailboxState: undefined }))).toBeNull();
    expect(folderIconPrunePlan(null, shown({ ownIds: [] }))).toBeNull();
  });

  it('keys the plan by account: the same token on another account prunes that account', () => {
    expect(folderIconPrunePlan('appA|s1', shown({ accountId: 'appB' }))?.accountId).toBe('appB');
  });
});
