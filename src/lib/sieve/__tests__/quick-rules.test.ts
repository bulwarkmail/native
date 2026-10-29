import { describe, it, expect } from 'vitest';
import {
  applyQuickRule,
  buildPrefillRule,
  buildPresetRule,
  extractListId,
  quickRuleSubject,
  ruleTargetMailboxes,
  toRuleMailbox,
} from '../quick-rules';
import { generateScript } from '../generator';
import type { Email, Mailbox } from '../../../api/types';
import type { FilterRule } from '../types';

const t = (_key: string, fallback: string, params?: Record<string, string | number>) =>
  fallback.replace(/\{(\w+)\}/g, (_m, k) => String(params?.[k] ?? ''));

const mailbox = (id: string, name: string, extra: Partial<Mailbox> = {}): Mailbox =>
  ({ id, name, role: null, parentId: null, myRights: { mayAddItems: true }, ...extra }) as unknown as Mailbox;

const MAILBOXES = [
  mailbox('inbox', 'Inbox', { role: 'inbox' }),
  mailbox('news', 'Newsletters', { parentId: 'inbox' }),
  mailbox('junk', 'Junk', { role: 'junk' }),
  mailbox('drafts', 'Drafts', { role: 'drafts' }),
];

const email = {
  from: [{ name: 'Anna', email: 'Anna@Acme.com' }],
  headers: [{ name: 'List-Id', value: 'Weekly news\r\n <news.acme.com>' }],
} as Pick<Email, 'from' | 'headers'>;

describe('quick rules from a message', () => {
  const subject = quickRuleSubject([email], new Set(['me@example.org']));

  it('takes the sender, its domain and the List-Id from the message', () => {
    expect(subject).toEqual({
      senders: [{ email: 'anna@acme.com', name: 'Anna' }],
      domain: 'acme.com',
      listId: 'news.acme.com',
    });
  });

  it('leaves the user\'s own address out', () => {
    expect(quickRuleSubject([{ from: [{ email: 'me@example.org' }] } as Email], new Set(['me@example.org'])).senders).toEqual([]);
  });

  it('reads a List-Id without brackets whole and refuses one with spaces', () => {
    expect(extractListId('list.example.org')).toBe('list.example.org');
    expect(extractListId('two words')).toBeNull();
  });

  // The rules match the exact address or domain, so a save keeps them exact.
  it('moves from the exact sender into the folder by id and path', () => {
    const rule = buildPresetRule({ kind: 'move_sender', mailbox: toRuleMailbox(MAILBOXES, MAILBOXES[1]) }, subject, t, 'r1');
    expect(rule).toMatchObject({
      name: 'Move from anna@acme.com to Newsletters',
      conditions: [{ field: 'from', comparator: 'address_is', value: 'anna@acme.com' }],
      actions: [{ type: 'move', value: 'INBOX/Newsletters', mailboxId: 'news' }],
      stopProcessing: true,
    });
    expect(generateScript([rule])).toContain('if address :is "From" "anna@acme.com" {');
  });

  it('moves a whole domain or list', () => {
    const target = toRuleMailbox(MAILBOXES, MAILBOXES[1]);
    expect(buildPresetRule({ kind: 'move_domain', mailbox: target }, subject, t, 'r').conditions)
      .toEqual([{ field: 'from', comparator: 'domain_is', value: 'acme.com' }]);
    expect(buildPresetRule({ kind: 'move_list', mailbox: target }, subject, t, 'r').conditions)
      .toEqual([{ field: 'header', headerName: 'List-Id', comparator: 'contains', value: 'news.acme.com' }]);
  });

  it('blocks into Junk without the spam guard', () => {
    const rule = buildPresetRule({ kind: 'block', junk: toRuleMailbox(MAILBOXES, MAILBOXES[2]) }, subject, t, 'r');
    expect(rule.includeSpam).toBe(true);
    expect(rule.actions).toEqual([{ type: 'move', value: 'Junk', mailboxId: 'junk' }]);
  });

  it('offers every folder that takes mail but Drafts', () => {
    expect(ruleTargetMailboxes(MAILBOXES).map((m) => m.id)).toEqual(['inbox', 'news', 'junk']);
  });

  it('opens the editor on the senders with a move to pick', () => {
    expect(buildPrefillRule(subject, t, 'p')).toMatchObject({
      name: 'Mail from anna@acme.com',
      conditions: [{ field: 'from', comparator: 'address_is', value: 'anna@acme.com' }],
      actions: [{ type: 'move', value: '' }],
    });
  });
});

describe('applyQuickRule', () => {
  const target = toRuleMailbox(MAILBOXES, MAILBOXES[1]);
  const make = (address: string, id: string): FilterRule =>
    buildPresetRule({ kind: 'move_sender', mailbox: target }, { senders: [{ email: address }], domain: null, listId: null }, t, id);

  it('puts a new rule at the top', () => {
    const other = make('x@y.z', 'old');
    const outcome = applyQuickRule([{ ...other, actions: [{ type: 'mark_read' }] }], make('a@b.c', 'new'));
    expect(outcome.kind).toBe('created');
    if (outcome.kind !== 'covered') expect(outcome.rules[0].id).toBe('new');
  });

  it('adds the sender to a rule that already does the same', () => {
    const outcome = applyQuickRule([make('x@y.z', 'old')], make('a@b.c', 'new'));
    expect(outcome.kind).toBe('merged');
    if (outcome.kind === 'merged') {
      expect(outcome.rules).toHaveLength(1);
      expect(outcome.rule.conditions[0].value).toEqual(['x@y.z', 'a@b.c']);
    }
  });

  it('writes nothing when a rule covers the sender already', () => {
    expect(applyQuickRule([make('A@b.c', 'old')], make('a@b.c', 'new')).kind).toBe('covered');
  });

  it('never merges into a rule with a period', () => {
    const timed = { ...make('x@y.z', 'old'), activeUntil: '2030-01-01T00:00:00.000Z' };
    expect(applyQuickRule([timed], make('a@b.c', 'new')).kind).toBe('created');
  });
});
