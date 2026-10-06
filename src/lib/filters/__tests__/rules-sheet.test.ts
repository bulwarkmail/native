import { describe, it, expect } from 'vitest';
import { rulesSheetItems, type RulesSheetModel } from '../rules-sheet';
import { collectSenders, rulesMenuAvailability, sharedDomain } from '../quick-rules';

const own = new Set(['me@example.org']);
const anna = { from: [{ name: 'Anna Schmidt', email: 'anna@acme.com' }] };

function model(overrides: Partial<RulesSheetModel> = {}): RulesSheetModel {
  const senders = collectSenders([anna], own);
  return {
    availability: 'available',
    senders,
    domain: sharedDomain(senders),
    listId: null,
    hasJunk: true,
    hasTags: true,
    opaque: false,
    ...overrides,
  };
}

const byId = (items: ReturnType<typeof rulesSheetItems>, id: string) => items.find((i) => i.id === id);

describe('rulesSheetItems', () => {
  it('is empty for an account without Sieve and for a shared account', () => {
    const noSieve = rulesMenuAvailability([{ key: 'a', shared: false, supportsSieve: false }]);
    const shared = rulesMenuAvailability([{ key: 'a', shared: true, supportsSieve: true }]);
    expect(rulesSheetItems(model({ availability: noSieve }))).toEqual([]);
    expect(rulesSheetItems(model({ availability: shared }))).toEqual([]);
  });

  it('offers every preset for one sender, in order, none disabled', () => {
    const items = rulesSheetItems(model());
    expect(items.map((i) => i.id)).toEqual([
      'move_sender', 'move_domain', 'mark_read', 'tag', 'block', 'create', 'manage',
    ]);
    expect(items.every((i) => !i.disabled && !i.hint)).toBe(true);
  });

  it('disables every item, with the reason, for a selection that spans accounts', () => {
    const availability = rulesMenuAvailability([
      { key: 'a', shared: false, supportsSieve: true },
      { key: 'b', shared: false, supportsSieve: true },
    ]);
    const items = rulesSheetItems(model({ availability }));
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.disabled && i.hint === 'context_menu.rules.cross_account')).toBe(true);
  });

  it('locks every item but Manage rules when the script was edited by hand', () => {
    const items = rulesSheetItems(model({ opaque: true, listId: 'news.acme.com' }));
    for (const item of items) {
      if (item.id === 'manage') {
        expect(item.disabled).toBe(false);
      } else {
        expect(item.disabled).toBe(true);
        expect(item.hint).toBe('context_menu.rules.opaque_hint');
      }
    }
  });

  it('disables Block with a hint when the account has no Junk folder', () => {
    const block = byId(rulesSheetItems(model({ hasJunk: false })), 'block')!;
    expect(block.disabled).toBe(true);
    expect(block.hint).toBe('context_menu.rules.no_junk');
    expect(byId(rulesSheetItems(model()), 'block')!.disabled).toBe(false);
  });

  it('offers the domain item only when every sender shares one domain', () => {
    const same = collectSenders([anna, { from: [{ email: 'bob@acme.com' }] }], own);
    expect(byId(rulesSheetItems(model({ senders: same, domain: sharedDomain(same) })), 'move_domain')).toBeTruthy();
    const mixed = collectSenders([anna, { from: [{ email: 'bob@other.org' }] }], own);
    expect(sharedDomain(mixed)).toBeNull();
    expect(byId(rulesSheetItems(model({ senders: mixed, domain: sharedDomain(mixed) })), 'move_domain')).toBeUndefined();
  });

  it('offers the list item only when a shared List-Id exists', () => {
    expect(byId(rulesSheetItems(model()), 'move_list')).toBeUndefined();
    expect(byId(rulesSheetItems(model({ listId: 'news.acme.com' })), 'move_list')).toBeTruthy();
  });

  it('leaves out the tag item when there are no tags', () => {
    expect(byId(rulesSheetItems(model({ hasTags: false })), 'tag')).toBeUndefined();
  });

  it('excludes own addresses from senders, so a message of your own gets only Create and Manage', () => {
    const senders = collectSenders([{ from: [{ email: 'ME@example.org' }] }], own);
    expect(senders).toEqual([]);
    const items = rulesSheetItems(model({ senders, domain: sharedDomain(senders) }));
    expect(items.map((i) => i.id)).toEqual(['create', 'manage']);
    expect(items.every((i) => !i.disabled)).toBe(true);
  });

  it('keeps the list item for a list message even when every sender is the user', () => {
    const items = rulesSheetItems(model({ senders: [], domain: null, listId: 'news.acme.com' }));
    expect(items.map((i) => i.id)).toEqual(['move_list', 'create', 'manage']);
  });
});
