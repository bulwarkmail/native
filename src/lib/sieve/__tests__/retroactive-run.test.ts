import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../../api/jmap-client', () => ({
  jmapClient: { accountId: 'own', getMaxObjectsInGet: () => 2, getMaxObjectsInSet: () => 2, request: vi.fn() },
}));

import { applyRuleToMailbox } from '../retroactive-run';
import type { FilterRule } from '../types';

// Webmail 1.21: a new rule can also be run on the mail already in the Inbox.
type Call = [string, Record<string, unknown>, string];

const inbox = [
  { id: 'm1', mailboxIds: { inbox: true }, keywords: {}, 'header:Subject:asText:all': ['Weekly news'], 'header:Subject:all': [' Weekly news'] },
  { id: 'm2', mailboxIds: { inbox: true }, keywords: {}, 'header:Subject:asText:all': ['Invoice'], 'header:Subject:all': [' Invoice'] },
  { id: 'm3', mailboxIds: { inbox: true }, keywords: { $seen: true }, 'header:Subject:asText:all': ['news, again'], 'header:Subject:all': [' news, again'] },
];

function server() {
  const sets: Array<Record<string, unknown>> = [];
  const send = vi.fn(async (calls: Call[]) => {
    const [name, args] = calls[0];
    if (name === 'Email/query') {
      const position = args.position as number;
      const page = inbox.slice(position, position + (args.limit as number));
      return { methodResponses: [['Email/query', { ids: page.map((m) => m.id) }, '0'], ['Email/get', { list: page }, '1']] as Call[] };
    }
    sets.push(args.update as Record<string, unknown>);
    return { methodResponses: [['Email/set', { updated: Object.fromEntries(Object.keys(args.update as object).map((id) => [id, null])) }, '0']] as Call[] };
  });
  return { send, sets };
}

const rule: FilterRule = {
  id: 'r', name: 'News', enabled: true, matchType: 'all',
  conditions: [{ field: 'subject', comparator: 'contains', value: 'news' }],
  actions: [{ type: 'mark_read' }, { type: 'move', value: 'News', mailboxId: 'news' }],
  stopProcessing: true,
};

describe('running a rule over the Inbox', () => {
  it('reads the Inbox page by page and changes only the matching messages', async () => {
    const { send, sets } = server();

    const count = await applyRuleToMailbox(rule, 'inbox', 'own', send);

    expect(count).toBe(2);
    expect(send.mock.calls.filter(([calls]) => calls[0][0] === 'Email/query').map(([calls]) => calls[0][1].position)).toEqual([0, 2]);
    expect(sets).toEqual([
      { m1: { 'keywords/$seen': true } },
      { m1: { mailboxIds: { news: true } }, m3: { mailboxIds: { news: true } } },
    ]);
  });

  it('changes nothing for a rule old mail cannot be run through', async () => {
    const { send } = server();
    const forward: FilterRule = { ...rule, actions: [{ type: 'forward', value: 'x@example.org' }] };
    expect(await applyRuleToMailbox(forward, 'inbox', 'own', send)).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  // No render setup in the repo: the editor and the settings page are
  // checked for offering it and running it after the save.
  it('is offered in the rule editor and run after the rule is saved', () => {
    const settings = readFileSync(join(__dirname, '../../../components/settings/FilterSettings.tsx'), 'utf-8');
    expect(settings).toMatch(/applyExisting=\{inboxOffer \?\? undefined\}/);
    expect(settings).toMatch(/if \(!saved \|\| !options\?\.applyToExisting \|\| !inboxOffer\) return;\r?\n\s+try \{\r?\n\s+const count = await applyRuleToMailbox\(rule, inboxOffer\.id\);/);
    const modal = readFileSync(join(__dirname, '../../../components/filters/FilterRuleModal.tsx'), 'utf-8');
    expect(modal).toMatch(/\}, \{ applyToExisting: applyToExisting && canTickApply \}\);/);
  });
});
