import { describe, expect, it } from 'vitest';
import { buildShareSetCalls, parseShareTargets, readShareSetResults, type ShareChange } from '../share-batch';
import { CALENDAR_PRESETS, FILE_PRESETS, MAILBOX_PRESETS } from '../share-rights';

// Ported from the pure part of the webmail's lib/__tests__/jmap-share-batch.test.ts.

const change = (kind: ShareChange['kind'], id: string, rights: ShareChange['rights'], principalId = 'ck', accountId = 'ci'): ShareChange =>
  ({ kind, accountId, id, name: id, principalId, rights });

describe('buildShareSetCalls', () => {
  it('puts each type in one call with a shareWith patch per item', () => {
    const { calls } = buildShareSetCalls([
      change('mailbox', 'a', MAILBOX_PRESETS.read),
      change('mailbox', 'b', MAILBOX_PRESETS.read),
      change('calendar', 'c2', CALENDAR_PRESETS.read),
      change('file', 'n1', null),
    ], { maxObjectsInSet: 500 });
    expect(calls).toEqual([
      ['Mailbox/set', { accountId: 'ci', update: { a: { 'shareWith/ck': MAILBOX_PRESETS.read }, b: { 'shareWith/ck': MAILBOX_PRESETS.read } } }, 's0'],
      ['Calendar/set', { accountId: 'ci', update: { c2: { 'shareWith/ck': CALENDAR_PRESETS.read } } }, 's1'],
      ['FileNode/set', { accountId: 'ci', update: { n1: { 'shareWith/ck': null } } }, 's2'],
    ]);
  });

  it('splits a type past maxObjectsInSet', () => {
    const changes = ['a', 'b', 'c'].map((id) => change('mailbox', id, null));
    const { calls, changesByCall } = buildShareSetCalls(changes, { maxObjectsInSet: 2 });
    expect(calls.map(([, args]) => Object.keys(args.update as object))).toEqual([['a', 'b'], ['c']]);
    expect(changesByCall.get('s1')!.map((c) => c.id)).toEqual(['c']);
  });

  it('converts rights through wireRights, but never a revoke', () => {
    const { calls } = buildShareSetCalls([change('file', 'n1', FILE_PRESETS.read), change('file', 'n2', null)], {
      maxObjectsInSet: 500,
      wireRights: () => ({ mayRead: true, mayWrite: false, mayShare: false }),
    });
    expect(calls[0][1].update).toEqual({ n1: { 'shareWith/ck': { mayRead: true, mayWrite: false, mayShare: false } }, n2: { 'shareWith/ck': null } });
  });
});

describe('readShareSetResults', () => {
  it('reports each item: updated, refused with the reason, or the whole call failing', () => {
    const changes = [
      change('mailbox', 'a', MAILBOX_PRESETS.read),
      change('mailbox', 'b', MAILBOX_PRESETS.read),
      change('mailbox', 'z', MAILBOX_PRESETS.read),
      change('calendar', 'c2', CALENDAR_PRESETS.read),
    ];
    const { calls, changesByCall } = buildShareSetCalls(changes, { maxObjectsInSet: 500 });
    const results = readShareSetResults(calls, changesByCall, [
      ['Mailbox/set', { updated: { a: null }, notUpdated: { b: { type: 'forbidden', description: 'You may not share this folder' } } }, 's0'],
      ['error', { type: 'forbidden' }, 's1'],
    ]);
    expect(results.map((r) => [r.change.id, r.ok, r.error])).toEqual([
      ['a', true, undefined],
      ['b', false, 'You may not share this folder'],
      ['z', false, undefined],
      ['c2', false, 'forbidden'],
    ]);
  });
});

describe('parseShareTargets', () => {
  it('reads every type and names the ones whose call failed', () => {
    const { targets, failed } = parseShareTargets([
      ['Mailbox/get', { list: [{ id: 'a', name: 'Inbox', role: 'inbox', parentId: null, shareWith: { ck: MAILBOX_PRESETS.read } }] }, 'm'],
      ['error', { type: 'serverFail' }, 'c'],
      ['AddressBook/get', { list: [{ id: 'ab', name: 'Contacts', isDefault: true, shareWith: null }] }, 'a'],
    ], { mailbox: 'ci', calendar: 'ci', addressBook: 'ci' });
    expect(targets).toEqual([
      { kind: 'mailbox', accountId: 'ci', id: 'a', name: 'Inbox', role: 'inbox', parentId: null, shareWith: { ck: MAILBOX_PRESETS.read } },
      { kind: 'addressBook', accountId: 'ci', id: 'ab', name: 'Contacts', isDefault: true, shareWith: {} },
    ]);
    expect(failed).toEqual(['calendar']);
  });
});
