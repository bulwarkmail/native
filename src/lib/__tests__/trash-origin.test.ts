import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Trash had no Restore, and a selection of read and unread mail could only
// be marked read (webmail lib/trash-origin.ts, e8d8486b8).

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (k: string) => storage.get(k) ?? null),
    setItem: vi.fn(async (k: string, v: string) => { storage.set(k, v); }),
  },
}));

import { loadTrashOrigins, rememberTrashOrigins, resetTrashOriginsForTests, restoreTarget, restoreTargetForAll } from '../trash-origin';

const MAILBOXES = [
  { id: 'inbox', role: 'inbox' },
  { id: 'work', role: null },
  { id: 'readonly', role: null, myRights: { mayAddItems: false } },
  { id: 'trash', role: 'trash' },
  { id: 'grp:inbox', role: 'inbox', isShared: true, accountId: 'grp' },
  { id: 'grp:trash', role: 'trash', isShared: true, accountId: 'grp' },
  { id: 'grp:support', role: null, isShared: true, accountId: 'grp' },
];

beforeEach(() => {
  storage.clear();
  resetTrashOriginsForTests();
});

describe('Restore from Trash', () => {
  it('puts a message back in the folder it left for Trash', () => {
    rememberTrashOrigins(['e1'], 'work', 'trash');
    expect(restoreTarget('e1', 'trash', MAILBOXES)).toBe('work');
  });

  it('falls back to the Inbox of the account without a note, or when the folder is gone or takes no mail', () => {
    expect(restoreTarget('e9', 'trash', MAILBOXES)).toBe('inbox');
    rememberTrashOrigins(['e2'], 'gone', 'trash');
    expect(restoreTarget('e2', 'trash', MAILBOXES)).toBe('inbox');
    rememberTrashOrigins(['e3'], 'readonly', 'trash');
    expect(restoreTarget('e3', 'trash', MAILBOXES)).toBe('inbox');
    // A group account's Trash goes back to the group's Inbox.
    expect(restoreTarget('e9', 'grp:trash', MAILBOXES)).toBe('grp:inbox');
  });

  it('keeps the notes of each account apart, as ids repeat across accounts', () => {
    rememberTrashOrigins(['e1'], 'grp:support', 'grp:trash');
    expect(restoreTarget('e1', 'grp:trash', MAILBOXES)).toBe('grp:support');
    expect(restoreTarget('e1', 'trash', MAILBOXES)).toBe('inbox');
  });

  it('sends a selection to one folder: where all came from, or the Inbox when they differ', () => {
    rememberTrashOrigins(['a', 'b'], 'work', 'trash');
    expect(restoreTargetForAll(['a', 'b'], 'trash', MAILBOXES)).toBe('work');
    expect(restoreTargetForAll(['a', 'x'], 'trash', MAILBOXES)).toBe('inbox');
    expect(restoreTargetForAll([], 'trash', MAILBOXES)).toBeUndefined();
  });

  it('keeps the notes over a restart', async () => {
    rememberTrashOrigins(['e1'], 'work', 'trash');
    await new Promise((r) => setTimeout(r, 0));
    resetTrashOriginsForTests();
    await loadTrashOrigins();
    expect(restoreTarget('e1', 'trash', MAILBOXES)).toBe('work');
  });

  it('is noted on delete and offered in the Trash selection bar and the reader', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '../..', p), 'utf8');
    const store = read('stores/email-store.ts');
    expect(store).toMatch(/rememberTrashOrigins\(\[emailId\], currentMailboxId, trashMailboxId\);/);
    expect(store).toMatch(/rememberTrashOrigins\(trashed\.map\(\(e\) => e\.id\), currentMailboxId, trashMailboxId\);/);
    const list = read('screens/EmailListScreen.tsx');
    expect(list).toMatch(/restoreTargetForAll\(selectedEmails\.map\(\(e\) => e\.id\), currentMailboxId, mailboxes\)/);
    expect(list).toMatch(/onPress: \(\) => handleBatchMovePick\(restoreTo\),/);
    // Read and unread selected: both actions.
    expect(list).toMatch(/\.\.\.\(selectionMixedRead \? \[\{\r?\n\s*key: 'unread' as const,/);
    const reader = read('screens/EmailThreadScreen.tsx');
    expect(reader).toMatch(/onRestore=\{restoreTo \? \(\) => onMoveToMailbox\(restoreTo\) : undefined\}/);
  });
});
