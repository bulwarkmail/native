import { describe, expect, it } from 'vitest';
import {
  allowedLevels,
  buildGrantChanges,
  buildRevokeChanges,
  changeStartFor,
  selectTargets,
  summarizeDelegates,
} from '../delegation';
import type { ShareTarget } from '../share-batch';
import { ADDRESS_BOOK_PRESETS, CALENDAR_PRESETS, FILE_PRESETS, MAILBOX_PRESETS } from '../share-rights';

// Ported from the webmail's lib/delegation/__tests__/delegation.test.ts.

const CAROL = 'ck';
const BOB = 'cj';

// A 1.0-style read grant of a folder: keywords come back with seen.
const MAILBOX_READ_STORED = { ...MAILBOX_PRESETS.read, maySetKeywords: true };

function targets(): ShareTarget[] {
  return [
    { kind: 'mailbox', accountId: 'ci', id: 'a', name: 'Inbox', role: 'inbox', shareWith: {} },
    { kind: 'mailbox', accountId: 'ci', id: 'b', name: 'Deleted Items', role: 'trash', shareWith: {} },
    { kind: 'mailbox', accountId: 'ci', id: 'f', name: 'Projects', role: null, shareWith: { [BOB]: MAILBOX_PRESETS.readWrite } },
    { kind: 'calendar', accountId: 'ci', id: 'c1', name: 'Work', isDefault: false, shareWith: {} },
    { kind: 'calendar', accountId: 'ci', id: 'c2', name: 'Personal', isDefault: true, shareWith: {} },
    { kind: 'addressBook', accountId: 'ci', id: 'ab', name: 'Contacts', isDefault: true, shareWith: {} },
    { kind: 'addressBook', accountId: 'ci', id: 'ts', name: 'Trusted Senders', isDefault: false, shareWith: {} },
    { kind: 'file', accountId: 'ci', id: 'n1', name: 'report.pdf', shareWith: { [CAROL]: FILE_PRESETS.read } },
  ];
}

const ids = (list: { kind: string; id: string }[]) => list.map((t) => `${t.kind}:${t.id}`);

describe('selectTargets', () => {
  it('takes every folder, the default calendar and the default address book by default', () => {
    expect(ids(selectTargets(targets(), { mail: 'all', calendars: 'default', addressBooks: 'default' }))).toEqual([
      'mailbox:a', 'mailbox:b', 'mailbox:f', 'calendar:c2', 'addressBook:ab',
    ]);
  });

  it('takes only the Inbox, every calendar, and no address book', () => {
    expect(ids(selectTargets(targets(), { mail: 'inbox', calendars: 'all', addressBooks: 'none' }))).toEqual([
      'mailbox:a', 'calendar:c1', 'calendar:c2',
    ]);
  });

  it('leaves out the trusted senders list and files even with "all"', () => {
    const picked = ids(selectTargets(targets(), { mail: 'none', calendars: 'none', addressBooks: 'all' }));
    expect(picked).toEqual(['addressBook:ab']);
  });

  it('uses the first calendar when none is marked default', () => {
    const list = targets().map((t) => (t.kind === 'calendar' ? { ...t, isDefault: false } : t));
    expect(ids(selectTargets(list, { mail: 'none', calendars: 'default', addressBooks: 'none' }))).toEqual(['calendar:c1']);
  });
});

describe('buildGrantChanges', () => {
  it('builds read patches per type', () => {
    const changes = buildGrantChanges(targets(), CAROL, { mail: 'inbox', calendars: 'default', addressBooks: 'default' }, 'read');
    expect(changes).toEqual([
      { kind: 'mailbox', accountId: 'ci', id: 'a', name: 'Inbox', principalId: CAROL, rights: MAILBOX_PRESETS.read },
      { kind: 'calendar', accountId: 'ci', id: 'c2', name: 'Personal', principalId: CAROL, rights: CALENDAR_PRESETS.read },
      { kind: 'addressBook', accountId: 'ci', id: 'ab', name: 'Contacts', principalId: CAROL, rights: ADDRESS_BOOK_PRESETS.read },
    ]);
  });

  it('builds read and write patches that never let a delegate send or re-share', () => {
    const changes = buildGrantChanges(targets(), CAROL, { mail: 'inbox', calendars: 'default', addressBooks: 'default' }, 'write');
    const [mail, calendar, book] = changes.map((c) => c.rights as unknown as Record<string, boolean>);
    expect(mail).toMatchObject({ mayReadItems: true, mayAddItems: true, mayRemoveItems: true, maySetKeywords: true, maySubmit: false, mayShare: false });
    expect(calendar).toMatchObject({ mayReadItems: true, mayWriteAll: true, mayShare: false });
    expect(book).toMatchObject({ mayRead: true, mayWrite: true, mayShare: false });
  });

  it('takes away what a change leaves out, but never files', () => {
    const list = targets();
    list[2].shareWith[CAROL] = MAILBOX_READ_STORED; // Projects
    list[3].shareWith[CAROL] = CALENDAR_PRESETS.read; // Work
    const changes = buildGrantChanges(list, CAROL, { mail: 'inbox', calendars: 'default', addressBooks: 'none' }, 'read', { replace: true });
    expect(changes.filter((c) => c.rights === null).map((c) => `${c.kind}:${c.id}`)).toEqual(['mailbox:f', 'calendar:c1']);
    expect(changes.some((c) => c.kind === 'file')).toBe(false);
  });

  it('takes nothing away without replace', () => {
    const list = targets();
    list[3].shareWith[CAROL] = CALENDAR_PRESETS.read;
    const changes = buildGrantChanges(list, CAROL, { mail: 'inbox', calendars: 'none', addressBooks: 'none' }, 'read');
    expect(changes.every((c) => c.rights !== null)).toBe(true);
  });
});

describe('buildRevokeChanges', () => {
  it('removes the person from everything, files included, and leaves others alone', () => {
    const list = targets();
    list[0].shareWith[CAROL] = MAILBOX_READ_STORED;
    list[4].shareWith[CAROL] = CALENDAR_PRESETS.readWrite;
    const changes = buildRevokeChanges(list, CAROL);
    expect(changes.map((c) => [`${c.kind}:${c.id}`, c.principalId, c.rights])).toEqual([
      ['mailbox:a', CAROL, null],
      ['calendar:c2', CAROL, null],
      ['file:n1', CAROL, null],
    ]);
  });
});

describe('summarizeDelegates', () => {
  it('groups grants by person and counts each type', () => {
    const list = targets();
    list[0].shareWith[CAROL] = MAILBOX_READ_STORED;
    list[1].shareWith[CAROL] = MAILBOX_READ_STORED;
    list[4].shareWith[CAROL] = CALENDAR_PRESETS.read;
    const summary = summarizeDelegates(list);
    expect(summary.map((s) => s.principalId)).toEqual([CAROL, BOB]);
    const carol = summary[0];
    expect(carol.level).toBe('read');
    expect(carol.mail).toEqual({ shared: 2, total: 3, inbox: true });
    expect(carol.calendars).toEqual({ shared: 1, total: 2 });
    expect(carol.addressBooks).toEqual({ shared: 0, total: 1 });
    expect(carol.files).toBe(1);
    expect(summary[1]).toMatchObject({ level: 'write', mail: { shared: 1, total: 3, inbox: false } });
  });

  it('says "mixed" when read and write grants meet, and leaves out excluded ids', () => {
    const list = targets();
    list[0].shareWith[CAROL] = MAILBOX_PRESETS.readWrite;
    const summary = summarizeDelegates(list, [BOB]);
    expect(summary.map((s) => [s.principalId, s.level])).toEqual([[CAROL, 'mixed']]);
  });

  it('gives a free/busy-only calendar no level', () => {
    const list = targets().filter((t) => t.kind !== 'file' && t.id !== 'f');
    list.find((t) => t.id === 'c1')!.shareWith[CAROL] = CALENDAR_PRESETS.freeBusy;
    expect(summarizeDelegates(list)[0].level).toBeNull();
  });
});

describe('changeStartFor', () => {
  const withCarol = (list: ShareTarget[], ids: string[], rights: object) => {
    for (const t of list) if (ids.includes(t.id)) t.shareWith[CAROL] = rights as never;
    return list;
  };

  it('starts from exact matches: every folder, the default calendar, read', () => {
    const list = withCarol(targets(), ['a', 'b', 'f'], MAILBOX_READ_STORED);
    withCarol(list, ['c2'], CALENDAR_PRESETS.read);
    expect(changeStartFor(list, CAROL)).toEqual({ scope: { mail: 'all', calendars: 'default', addressBooks: 'none' }, level: 'read' });
  });

  it('starts from Inbox only and all calendars, read and write', () => {
    const list = withCarol(targets(), ['a'], MAILBOX_PRESETS.readWrite);
    withCarol(list, ['c1', 'c2'], CALENDAR_PRESETS.readWrite);
    expect(changeStartFor(list, CAROL)).toEqual({ scope: { mail: 'inbox', calendars: 'all', addressBooks: 'none' }, level: 'write' });
  });

  it('keeps mail as it is when a folder was added after "all", and the patch leaves mail alone', () => {
    // Inbox and Trash shared, Projects created later.
    const list = withCarol(targets(), ['a', 'b'], MAILBOX_READ_STORED);
    const start = changeStartFor(list, CAROL);
    expect(start.scope.mail).toBe('keep');
    const changes = buildGrantChanges(list, CAROL, { ...start.scope, calendars: 'default' }, 'read', { replace: true });
    expect(changes.filter((c) => c.kind === 'mailbox')).toEqual([]);
  });

  it('keeps one shared non-Inbox folder as it is instead of turning it into the Inbox', () => {
    const list = withCarol(targets(), ['b'], MAILBOX_READ_STORED);
    expect(changeStartFor(list, CAROL).scope.mail).toBe('keep');
  });

  it('keeps a non-default calendar as it is', () => {
    const list = withCarol(targets(), ['c1'], CALENDAR_PRESETS.read);
    const start = changeStartFor(list, CAROL);
    expect(start.scope.calendars).toBe('keep');
    expect(buildGrantChanges(list, CAROL, start.scope, start.level, { replace: true })).toEqual([]);
  });

  it('keeps free/busy only as it is, until the user picks a scope', () => {
    const list = withCarol(targets(), ['c2'], CALENDAR_PRESETS.freeBusy);
    const start = changeStartFor(list, CAROL);
    expect(start.scope.calendars).toBe('keep');
    expect(start.level).toBe('keep');
    expect(buildGrantChanges(list, CAROL, start.scope, start.level, { replace: true })).toEqual([]);
    // Picking "Default calendar" with read replaces it.
    const picked = buildGrantChanges(list, CAROL, { ...start.scope, calendars: 'default' }, 'read', { replace: true });
    expect(picked.map((c) => [c.id, c.rights])).toEqual([['c2', CALENDAR_PRESETS.read]]);
  });

  it('keeps manager rights untouched', () => {
    const list = withCarol(targets(), ['a', 'b', 'f'], MAILBOX_PRESETS.manager);
    const start = changeStartFor(list, CAROL);
    expect(start).toEqual({ scope: { mail: 'keep', calendars: 'none', addressBooks: 'none' }, level: 'keep' });
    expect(buildGrantChanges(list, CAROL, start.scope, start.level, { replace: true })).toEqual([]);
  });

  it('keeps mixed levels per type: grants stay, anything added gets that type\'s level', () => {
    const list = withCarol(targets(), ['a', 'b', 'f'], MAILBOX_PRESETS.readWrite);
    withCarol(list, ['c2'], CALENDAR_PRESETS.read);
    const start = changeStartFor(list, CAROL);
    expect(start).toEqual({ scope: { mail: 'all', calendars: 'default', addressBooks: 'none' }, level: 'keep' });
    expect(buildGrantChanges(list, CAROL, start.scope, start.level, { replace: true })).toEqual([]);
    // Widening calendars to all adds Work at the calendars' level (read), not mail's (write).
    const wider = buildGrantChanges(list, CAROL, { ...start.scope, calendars: 'all' }, 'keep', { replace: true });
    expect(wider.map((c) => [c.id, c.rights])).toEqual([['c1', CALENDAR_PRESETS.read]]);
  });

  it('counts a shared trusted senders book as something the dialog cannot express', () => {
    const list = withCarol(targets(), ['ab', 'ts'], ADDRESS_BOOK_PRESETS.read);
    expect(changeStartFor(list, CAROL).scope.addressBooks).toBe('keep');
  });

  it('clamps a write delegate to read when the admin allows only read', () => {
    const list = withCarol(targets(), ['a'], MAILBOX_PRESETS.readWrite);
    expect(changeStartFor(list, CAROL, ['read'])).toEqual({ scope: { mail: 'inbox', calendars: 'none', addressBooks: 'none' }, level: 'read' });
    // Mixed with write starts at read too, so nothing keeps write by default.
    withCarol(list, ['c2'], CALENDAR_PRESETS.read);
    expect(changeStartFor(list, CAROL, ['read']).level).toBe('read');
  });
});

describe('allowedLevels', () => {
  it('offers both without a restriction', () => {
    expect(allowedLevels(null)).toEqual(['read', 'write']);
  });

  it('offers only what the admin allows', () => {
    expect(allowedLevels(['read'])).toEqual(['read']);
    expect(allowedLevels(['write'])).toEqual(['write']);
  });

  it('falls back to read when the list names neither', () => {
    expect(allowedLevels(['manager'])).toEqual(['read']);
  });
});
