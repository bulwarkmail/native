import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { moveSharedMailAccountBy, sharedMailOrderIds, sortSharedMailAccounts } from '../shared-mail-order';

// The shared accounts' order in the drawer (webmail lib/shared-mail-order.ts,
// 2b3b672b7); on the phone the shared account's sheet moves it up or down.

const nodes = (...ids: string[]) => ids.map((accountId) => ({ accountId }));
const ids = (list: { accountId?: string }[]) => list.map((n) => n.accountId);

describe('sortSharedMailAccounts', () => {
  it('keeps the incoming (alphabetical) order without a stored order', () => {
    expect(ids(sortSharedMailAccounts(nodes('a', 'b', 'c'), []))).toEqual(['a', 'b', 'c']);
    expect(ids(sortSharedMailAccounts(nodes('a', 'b', 'c'), undefined))).toEqual(['a', 'b', 'c']);
  });

  it('puts stored accounts first and appends the others in their incoming order', () => {
    expect(ids(sortSharedMailAccounts(nodes('a', 'b', 'c', 'd'), ['c', 'a']))).toEqual(['c', 'a', 'b', 'd']);
  });

  it('ignores stored ids of accounts that are not present', () => {
    expect(ids(sortSharedMailAccounts(nodes('a', 'b'), ['gone', 'b']))).toEqual(['b', 'a']);
  });
});

describe('sharedMailOrderIds', () => {
  it("reads one login's entry", () => {
    expect(sharedMailOrderIds({ x: ['a'] }, 'x')).toEqual(['a']);
    expect(sharedMailOrderIds({ x: ['a'] }, 'y')).toEqual([]);
    expect(sharedMailOrderIds(undefined, 'x')).toEqual([]);
    expect(sharedMailOrderIds({ x: 'a' as never }, 'x')).toEqual([]);
  });
});

describe('moveSharedMailAccountBy', () => {
  it('moves an account one place up or down', () => {
    expect(moveSharedMailAccountBy({}, 'x', ['a', 'b', 'c'], 'a', 1)).toEqual({ x: ['b', 'a', 'c'] });
    expect(moveSharedMailAccountBy({}, 'x', ['a', 'b', 'c'], 'c', -1)).toEqual({ x: ['a', 'c', 'b'] });
  });

  it('keeps stored ids whose account is not present, and leaves other logins alone', () => {
    const before = { x: ['gone', 'a', 'b'], y: ['q', 'p'] };
    const map = moveSharedMailAccountBy(before, 'x', ['a', 'b'], 'b', -1);
    expect(map).toEqual({ x: ['b', 'a', 'gone'], y: ['q', 'p'] });
    expect(before.x).toEqual(['gone', 'a', 'b']);
  });

  it('changes nothing past either end or for an unknown id', () => {
    const map = { x: ['a', 'b'] };
    expect(moveSharedMailAccountBy(map, 'x', ['a', 'b'], 'a', -1)).toBe(map);
    expect(moveSharedMailAccountBy(map, 'x', ['a', 'b'], 'b', 1)).toBe(map);
    expect(moveSharedMailAccountBy(map, 'x', ['a', 'b'], 'zz', 1)).toBe(map);
  });
});

describe('the drawer', () => {
  it('lists the shared accounts in the stored order and offers Move up and Move down', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'components', 'SidebarDrawer.tsx'), 'utf8');
    expect(source).toMatch(/sortSharedMailAccounts\(shared, sharedMailOrderIds\(sharedOrder, activeAccountId\)\)/);
    expect(source).toMatch(/key: 'move-up',\r?\n\s*label: t\('mailbox_context_menu\.move_shared_account_up', 'Move up'\)/);
    expect(source).toMatch(/key: 'move-down',\r?\n\s*label: t\('mailbox_context_menu\.move_shared_account_down', 'Move down'\)/);
  });
});
