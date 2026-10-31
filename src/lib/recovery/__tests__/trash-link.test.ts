import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isOwnTrash, trashRecoveryLinkVisible } from '../trash-link';
import { useRecoveryStore, type RecentCheck, type RecoveryClient } from '../recovery-store';
import type { Mailbox } from '../../../api/types';

// The Trash header leads to Settings > Recover deleted items (webmail
// components/email/trash-recovery-link.tsx and its test): only in the
// account's own Trash, when the server offers recovery, and when the archive
// holds a message inside the days window it was looked up for.

const TRASH = { id: 't', name: 'Trash', role: 'trash', accountId: 'ci' } as Mailbox;
const HAS: RecentCheck = { has: true, days: 14, checkedAt: 0 };

function visible(over: Partial<Parameters<typeof trashRecoveryLinkVisible>[0]> = {}): boolean {
  return trashRecoveryLinkVisible({ available: true, ownTrash: true, recent: HAS, days: 14, ...over });
}

afterEach(() => useRecoveryStore.getState().reset());

describe('isOwnTrash', () => {
  it("is the account's own Trash, with or without an account id on the folder", () => {
    expect(isOwnTrash(TRASH, 'ci')).toBe(true);
    expect(isOwnTrash({ ...TRASH, accountId: undefined }, 'ci')).toBe(true);
  });

  it("is not another folder, a shared or group account's Trash, or anything before the session", () => {
    expect(isOwnTrash({ ...TRASH, role: 'inbox' }, 'ci')).toBe(false);
    expect(isOwnTrash({ ...TRASH, accountId: 'ch', isShared: true }, 'ci')).toBe(false);
    expect(isOwnTrash({ ...TRASH, accountId: undefined, isShared: true }, 'ci')).toBe(false);
    expect(isOwnTrash({ ...TRASH, accountId: 'ch' }, 'ci')).toBe(false);
    expect(isOwnTrash(undefined, 'ci')).toBe(false);
    expect(isOwnTrash(TRASH, null)).toBe(false);
  });
});

describe('trashRecoveryLinkVisible', () => {
  it('shows when recovery is offered and the archive has a recent message', () => {
    expect(visible()).toBe(true);
  });

  it('hides when the archive holds nothing inside the days, or has not been looked at', () => {
    expect(visible({ recent: { ...HAS, has: false } })).toBe(false);
    expect(visible({ recent: undefined })).toBe(false);
  });

  it('hides when the server refuses, outside the own Trash, or when the look was for other days', () => {
    expect(visible({ available: false })).toBe(false);
    expect(visible({ ownTrash: false })).toBe(false);
    expect(visible({ days: 30 })).toBe(false);
  });

  it("follows the store's look at the archive, and hides again after a restore", async () => {
    const client: RecoveryClient = {
      advertisesArchivedItems: () => true,
      queryArchivedItemIds: vi.fn(async () => ({ ids: [], total: null }) as never),
      hasArchivedEmail: vi.fn(async () => true),
    };
    const key = 'acc-alice|ci';
    await useRecoveryStore.getState().checkRecent(client, key, 14);
    expect(client.hasArchivedEmail).toHaveBeenCalledWith({ days: 14 });
    expect(visible({ recent: useRecoveryStore.getState().recent[key] })).toBe(true);
    useRecoveryStore.getState().forgetRecent(key);
    expect(visible({ recent: useRecoveryStore.getState().recent[key] })).toBe(false);
  });
});

describe('Trash link wiring', () => {
  const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../..', rel), 'utf8');

  it('is mounted in the list header only when the open folder is the Trash', () => {
    const list = src('screens/EmailListScreen.tsx');
    expect(list).toMatch(/\{currentMailbox\?\.role === 'trash' && <TrashRecoveryLink mailbox=\{currentMailbox\} \/>\}/);
  });

  it("looks at the open folder's account and opens Settings > Recover deleted items", () => {
    const link = src('components/email/TrashRecoveryLink.tsx');
    expect(link).toMatch(/const \{ available, accountId, key \} = useDeletedItemsRecovery\(\);/);
    expect(link).toMatch(/const ownTrash = isOwnTrash\(mailbox, accountId\);/);
    expect(link).toMatch(/if \(!available \|\| !ownTrash \|\| !accountId \|\| !key\) return;/);
    expect(link).toMatch(/checkRecent\(recoveryClientFor\(accountId\), key, days\)/);
    expect(link).toMatch(/if \(!trashRecoveryLinkVisible\(\{ available, ownTrash, recent, days \}\)\) return null;/);
    expect(link).toMatch(/setPendingSettingsTab\('recovery'\);\s*navigation\.navigate\('MainTabs', \{ screen: 'Settings' \}/);
    expect(link).toMatch(/t\('recover_deleted\.trash_hint', /);
    expect(link).toMatch(/t\('recover_deleted\.trash_link', /);
    // A selector that builds a new object or array each time loops the render.
    expect(link).not.toMatch(/Store\(\(s\) => \(\{/);
    expect(link).not.toMatch(/Store\(\(s\) => [^;]*\.(filter|map)\(/);
    // The tab the link parks is one Settings opens.
    expect(src('screens/SettingsScreen.tsx')).toMatch(/\{ id: 'recovery', [^}]*implemented: true\s*\}/);
  });
});
