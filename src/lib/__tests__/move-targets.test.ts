import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { moveSheetCurrentId } from '../move-targets';
import type { Mailbox } from '../../api/types';

// A search across folders keeps the open folder selected, and the move
// sheet greyed it out, so a hit from another folder couldn't be moved into
// it (webmail dafdda534, #1452).

const box = (id: string, extra: Partial<Mailbox> = {}): Mailbox => ({ id, name: id, totalEmails: 0, unreadEmails: 0, ...extra } as Mailbox);
const mailboxes = [box('inbox'), box('work'), box('g:raw', { originalId: 'raw', accountId: 'g' })];

describe('move sheet current folder (bulwarkmail/webmail#1452)', () => {
  it('keeps the open folder out only when every row is already in it', () => {
    expect(moveSheetCurrentId(mailboxes, 'inbox', [{ mailboxIds: { inbox: true } }])).toBe('inbox');
    expect(moveSheetCurrentId(mailboxes, 'inbox', [{ mailboxIds: { work: true }, jmapAccountId: 'me' }])).toBeNull();
    expect(moveSheetCurrentId(mailboxes, 'inbox', [{ mailboxIds: { inbox: true } }, { mailboxIds: { work: true } }])).toBeNull();
    expect(moveSheetCurrentId(mailboxes, null, [{ mailboxIds: { work: true } }])).toBeNull();
  });

  it("matches a shared folder by its server id and account", () => {
    expect(moveSheetCurrentId(mailboxes, 'g:raw', [{ mailboxIds: { raw: true }, jmapAccountId: 'g' }])).toBe('g:raw');
    expect(moveSheetCurrentId(mailboxes, 'g:raw', [{ mailboxIds: { raw: true }, jmapAccountId: 'other' }])).toBeNull();
  });

  it('is what both move sheets of the list use', () => {
    const list = fs.readFileSync(path.resolve(__dirname, '../../screens/EmailListScreen.tsx'), 'utf8');
    expect(list).toMatch(/currentMailboxId=\{pendingMoveCurrentId\}/);
    expect(list).toMatch(/toId !== pendingMoveCurrentId/);
    expect(list).toMatch(/currentMailboxId=\{moveSheetCurrentId\(mailboxes, currentMailboxId, selectedEmails\)\}/);
  });
});
