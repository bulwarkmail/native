import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { handleDeepLink, parseDeepLink } from '../linking';
import { usePendingMailFolder } from '../pending-mail-folder';
import { resolveFolderRef } from '../../lib/folder-ref';
import type { Mailbox } from '../../api/types';

// A `mail/folder/<ref>` link opened only the Mail tab; the folder it named
// was dropped (file 10, "/mail/folder/<ref> deep link opens only the tab").

const box = (id: string, role: string | null, isShared = false) => ({ id, name: id, role, isShared } as unknown as Mailbox);

describe('mail/folder deep link', () => {
  it('parks the folder for the mail list', async () => {
    const link = parseDeepLink('bulwarkmobile://mail/folder/archive');
    const navigation = { isReady: () => true, navigate: vi.fn() };
    expect(await handleDeepLink(link!, { navigation: navigation as never, resolveThreadId: async () => null })).toBe(true);
    expect(usePendingMailFolder.getState().consume()).toBe('archive');
    expect(navigation.navigate).toHaveBeenCalledWith('MainTabs', { screen: 'Mail' });
  });

  it('resolves an id or a role, the own folder first, and nothing for an unknown one', () => {
    const boxes = [box('g:in', 'inbox', true), box('in', 'inbox'), box('f1', null)];
    expect(resolveFolderRef('f1', boxes)).toBe('f1');
    expect(resolveFolderRef('inbox', boxes)).toBe('in');
    expect(resolveFolderRef('trash', boxes)).toBeNull();
    expect(resolveFolderRef('gone', boxes)).toBeNull();
  });

  it('is opened by the mail list', () => {
    const list = fs.readFileSync(path.resolve(__dirname, '../../screens/EmailListScreen.tsx'), 'utf8');
    expect(list).toMatch(/const id = ref === null \? null : resolveFolderRef\(ref, mailboxes\);/);
    expect(list).toMatch(/if \(id !== currentMailboxId\) void selectMailbox\(id\);/);
  });
});
