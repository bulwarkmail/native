import { describe, it, expect } from 'vitest';
import type { FilterAction, FilterCondition, FilterRule } from '../../sieve/types';
import {
  planRetroactive,
  retroactiveSupport,
  retroProperties,
  retroQueryFilter,
  RetroactiveTooComplexError,
  ruleMatches,
  sieveMatches,
  toRetroMessage,
  type RetroMessage,
} from '../retroactive';

function rule(conditions: FilterCondition[], actions: FilterAction[] = [{ type: 'move', value: 'News', mailboxId: 'news' }], overrides: Partial<FilterRule> = {}): FilterRule {
  return { id: 'r', name: 'R', enabled: true, matchType: 'all', conditions, actions, stopProcessing: true, ...overrides };
}

function message(overrides: Partial<RetroMessage> & { fromAddress?: string; fromName?: string } = {}): RetroMessage {
  const { fromAddress = 'anna@acme.com', fromName = 'Anna', ...rest } = overrides;
  return {
    id: 'm1',
    mailboxIds: { inbox: true },
    keywords: {},
    from: [{ name: fromName, email: fromAddress }],
    to: [{ name: 'Me', email: 'me@example.org' }],
    cc: [],
    headers: {
      from: [`${fromName} <${fromAddress}>`],
      subject: ['Weekly report'],
    },
    ...rest,
  };
}

const sender = (value: string | string[]) => rule([{ field: 'from', comparator: 'address_is', value }]);
const domain = (value: string) => rule([{ field: 'from', comparator: 'domain_is', value }]);

describe('ruleMatches: exact sender', () => {
  it('matches the address whatever its case and display name', () => {
    expect(ruleMatches(sender('anna@acme.com'), message({ fromAddress: 'Anna@ACME.com' }))).toBe(true);
  });

  it('does not match joanna@acme.com for anna@acme.com', () => {
    expect(ruleMatches(sender('anna@acme.com'), message({ fromAddress: 'joanna@acme.com' }))).toBe(false);
  });

  it('matches any sender of the list', () => {
    const r = sender(['bob@acme.com', 'anna@acme.com']);
    expect(ruleMatches(r, message())).toBe(true);
    expect(ruleMatches(r, message({ fromAddress: 'carol@acme.com' }))).toBe(false);
  });
});

describe('ruleMatches: domain', () => {
  it('matches the exact domain', () => {
    expect(ruleMatches(domain('acme.com'), message({ fromAddress: 'anna@ACME.COM' }))).toBe(true);
  });

  it('matches neither acme.com.evil nor sub.acme.com (subdomains do not match)', () => {
    expect(ruleMatches(domain('acme.com'), message({ fromAddress: 'anna@acme.com.evil' }))).toBe(false);
    expect(ruleMatches(domain('acme.com'), message({ fromAddress: 'anna@sub.acme.com' }))).toBe(false);
    expect(ruleMatches(domain('acme.com'), message({ fromAddress: 'anna@notacme.com' }))).toBe(false);
  });
});

describe('ruleMatches: header comparators, as Sieve reads them', () => {
  it('contains on the raw header text, which is why address_is exists', () => {
    const r = rule([{ field: 'from', comparator: 'contains', value: 'anna@acme.com' }]);
    expect(ruleMatches(r, message({ fromAddress: 'joanna@acme.com' }))).toBe(true);
  });

  it('matches List-Id with contains, and not when the header is missing', () => {
    const r = rule([{ field: 'header', headerName: 'List-Id', comparator: 'contains', value: 'news.acme.com' }]);
    expect(ruleMatches(r, message({ headers: { 'list-id': ['Acme news <news.acme.com>'] } }))).toBe(true);
    expect(ruleMatches(r, message())).toBe(false);
  });

  it('negations hold when the header is missing', () => {
    const r = rule([{ field: 'header', headerName: 'X-Tag', comparator: 'not_contains', value: 'x' }]);
    expect(ruleMatches(r, message())).toBe(true);
    expect(ruleMatches(r, message({ headers: { 'x-tag': ['has x'] } }))).toBe(false);
  });

  it('folds ASCII only (i;ascii-casemap)', () => {
    const r = rule([{ field: 'subject', comparator: 'is', value: 'ärger' }]);
    expect(ruleMatches(r, message({ headers: { subject: ['Ärger'] } }))).toBe(false);
    expect(ruleMatches(r, message({ headers: { subject: ['äRGER'] } }))).toBe(true);
    const ascii = rule([{ field: 'subject', comparator: 'is', value: 'WEEKLY REPORT' }]);
    expect(ruleMatches(ascii, message())).toBe(true);
  });

  it('reads starts_with, ends_with and matches as globs', () => {
    expect(ruleMatches(rule([{ field: 'subject', comparator: 'starts_with', value: 'weekly' }]), message())).toBe(true);
    expect(ruleMatches(rule([{ field: 'subject', comparator: 'ends_with', value: 'REPORT' }]), message())).toBe(true);
    expect(ruleMatches(rule([{ field: 'subject', comparator: 'matches', value: 'W?ekly*' }]), message())).toBe(true);
    expect(ruleMatches(rule([{ field: 'subject', comparator: 'matches', value: 'report' }]), message())).toBe(false);
  });

  it('combines conditions by the match type', () => {
    const conditions: FilterCondition[] = [
      { field: 'from', comparator: 'address_is', value: 'anna@acme.com' },
      { field: 'subject', comparator: 'contains', value: 'invoice' },
    ];
    expect(ruleMatches(rule(conditions), message())).toBe(false);
    expect(ruleMatches(rule(conditions, undefined, { matchType: 'any' }), message())).toBe(true);
  });

  it('skips spam for a folder rule unless it opts in, like the spam guard', () => {
    const spam = message({ keywords: { $junk: true } });
    expect(ruleMatches(sender('anna@acme.com'), spam)).toBe(false);
    expect(ruleMatches(rule([{ field: 'from', comparator: 'address_is', value: 'anna@acme.com' }], undefined, { includeSpam: true }), spam)).toBe(true);
    expect(ruleMatches(rule([{ field: 'from', comparator: 'address_is', value: 'anna@acme.com' }], [{ type: 'mark_read' }]), spam)).toBe(true);
  });
});

describe('sieveMatches', () => {
  it('handles wildcards and escapes', () => {
    expect(sieveMatches('a*c', 'abbbc')).toBe(true);
    expect(sieveMatches('a?c', 'abc')).toBe(true);
    expect(sieveMatches('a?c', 'ac')).toBe(false);
    expect(sieveMatches('a\\*c', 'a*c')).toBe(true);
    expect(sieveMatches('a\\*c', 'abc')).toBe(false);
    expect(sieveMatches('(x).[y]', '(x).[y]')).toBe(true);
  });
});

describe('sieveMatches on large input', () => {
  const big = 'a'.repeat(200 * 1024);

  it('answers star-heavy patterns on a 200 KB value within the ceiling', () => {
    const started = Date.now();
    expect(sieveMatches('*a*a*a*a*b', big)).toBe(false);
    expect(sieveMatches('*a*a*a*a*a*a*a*a*a*a*b', big)).toBe(false);
    expect(sieveMatches('?*?*?*?*?*b', big)).toBe(false);
    expect(sieveMatches('*a*a*a*a*', big)).toBe(true);
    expect(sieveMatches('a*a*a*a*a?', big + 'b')).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('answers a long literal segment that almost matches in well under 5 ms on average', () => {
    const header = 'a'.repeat(8192);
    const pattern = `*${'a'.repeat(2000)}b`;
    const withAny = `*${'a'.repeat(1000)}?${'a'.repeat(1000)}b`;
    const started = performance.now();
    for (let i = 0; i < 100; i++) {
      expect(sieveMatches(pattern, header)).toBe(false);
      expect(sieveMatches(withAny, header)).toBe(false);
    }
    expect((performance.now() - started) / 200).toBeLessThan(5);
  });

  it('treats a trailing backslash and astral characters literally', () => {
    expect(sieveMatches('a\\', 'a\\')).toBe(true);
    expect(sieveMatches('?', '\u{1F600}')).toBe(true);
    expect(sieveMatches('??', '\u{1F600}')).toBe(false);
    expect(sieveMatches('*?x', '\u{1F600}x')).toBe(true);
  });
});

/** Reference matcher: plain recursion with memo, obviously right, slow. */
function referenceMatch(pattern: string, text: string): boolean {
  const tokens: Array<{ kind: 'star' | 'any' | 'lit'; ch?: string }> = [];
  const p = Array.from(pattern);
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '\\' && i + 1 < p.length) tokens.push({ kind: 'lit', ch: p[++i] });
    else if (p[i] === '*') tokens.push({ kind: 'star' });
    else if (p[i] === '?') tokens.push({ kind: 'any' });
    else tokens.push({ kind: 'lit', ch: p[i] });
  }
  const t = Array.from(text);
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = i * (t.length + 1) + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (i === tokens.length) result = j === t.length;
    else if (tokens[i].kind === 'star') result = go(i + 1, j) || (j < t.length && go(i, j + 1));
    else if (j >= t.length) result = false;
    else result = (tokens[i].kind === 'any' || tokens[i].ch === t[j]) && go(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

describe('sieveMatches equivalence', () => {
  it('agrees with a reference matcher on random globs and texts', () => {
    let seed = 12345;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const patternAlphabet = ['a', 'b', 'A', '*', '*', '?', '\\*', '\\?', '\\\\', '\u{1F600}', 'ab'];
    const textAlphabet = ['a', 'b', 'A', '*', '?', '\\', '\u{1F600}', 'a', 'b'];
    let matched = 0;
    for (let n = 0; n < 4000; n++) {
      let pattern = '';
      for (let i = rand(7); i > 0; i--) pattern += patternAlphabet[rand(patternAlphabet.length)];
      let text = '';
      for (let i = rand(9); i > 0; i--) text += textAlphabet[rand(textAlphabet.length)];
      const expected = referenceMatch(pattern, text);
      if (expected) matched++;
      expect(sieveMatches(pattern, text), `${JSON.stringify(pattern)} vs ${JSON.stringify(text)}`).toBe(expected);
    }
    expect(matched).toBeGreaterThan(200);
  });
});

describe('ruleMatches never shortens a value', () => {
  it('finds a needle past 4 KB in a header and keeps negations right', () => {
    const header = `${'a'.repeat(5000)}needle`;
    const contains = rule([{ field: 'subject', comparator: 'contains', value: 'needle' }]);
    expect(ruleMatches(contains, message({ headers: { subject: [header] } }))).toBe(true);
    const not = rule([{ field: 'subject', comparator: 'not_contains', value: 'needle' }]);
    expect(ruleMatches(not, message({ headers: { subject: [header] } }))).toBe(false);
  });

  it('keeps a rule value of 500 characters whole', () => {
    const value = `${'a'.repeat(499)}b`;
    const r = rule([{ field: 'subject', comparator: 'is', value }]);
    expect(ruleMatches(r, message({ headers: { subject: [`${'a'.repeat(499)}c`] } }))).toBe(false);
    expect(ruleMatches(r, message({ headers: { subject: [value] } }))).toBe(true);
  });

  it('skips a message whose compared header is over 8192 characters', () => {
    const huge = 'a'.repeat(8193);
    const contains = rule([{ field: 'subject', comparator: 'contains', value: 'a' }]);
    expect(ruleMatches(contains, message({ headers: { subject: [huge] } }))).toBe(false);
    // Fails closed for a negation too.
    const not = rule([{ field: 'subject', comparator: 'not_contains', value: 'zzz' }]);
    expect(ruleMatches(not, message({ headers: { subject: ['fine', huge] } }))).toBe(false);
    expect(ruleMatches(not, message({ headers: { subject: ['a'.repeat(8192)] } }))).toBe(true);
    const weekly = rule([{ field: 'subject', comparator: 'contains', value: 'week' }], [{ type: 'mark_read' }]);
    const plan = planRetroactive(weekly, [message({ id: 'big', headers: { subject: [`week${huge}`] } }), message({ id: 'ok' })]);
    expect(plan.ids).toEqual(['ok']);
  });
});

describe('retroactiveSupport limits', () => {
  const actions: FilterAction[] = [{ type: 'mark_read' }];
  const refused = { ok: false, reason: 'condition' };

  it('refuses a value over 512 characters', () => {
    expect(retroactiveSupport(rule([{ field: 'subject', comparator: 'contains', value: 'a'.repeat(513) }], actions))).toEqual(refused);
    expect(retroactiveSupport(rule([{ field: 'subject', comparator: 'contains', value: 'a'.repeat(512) }], actions)).ok).toBe(true);
  });

  it('refuses more than 50 values in one condition', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `v${i}`);
    expect(retroactiveSupport(rule([{ field: 'subject', comparator: 'contains', value: many(51) }], actions))).toEqual(refused);
    expect(retroactiveSupport(rule([{ field: 'subject', comparator: 'contains', value: many(50) }], actions)).ok).toBe(true);
  });

  it('refuses a rule whose patterns total over 8192 characters', () => {
    const conditions = (n: number): FilterCondition[] => Array.from({ length: n }, () => (
      { field: 'subject', comparator: 'contains', value: 'a'.repeat(512) } as FilterCondition
    ));
    expect(retroactiveSupport(rule(conditions(16), actions)).ok).toBe(true);
    expect(retroactiveSupport(rule([...conditions(16), { field: 'subject', comparator: 'contains', value: 'x' }], actions))).toEqual(refused);
    expect(planRetroactive(rule(conditions(17), actions), [message()])).toEqual({ ids: [], steps: [] });
  });
});

describe('planRetroactive budget', () => {
  it('aborts with RetroactiveTooComplexError past 50 million compared characters', () => {
    const r = rule([{ field: 'subject', comparator: 'contains', value: 'zzz' }], [{ type: 'mark_read' }]);
    const long = 'a'.repeat(8192);
    const messages = Array.from({ length: 7000 }, (_, i) => message({ id: `m${i}`, headers: { subject: [long] } }));
    expect(() => planRetroactive(r, messages)).toThrow(RetroactiveTooComplexError);
    expect(() => planRetroactive(r, messages.slice(0, 5000))).not.toThrow();
  });
});

describe('retroactiveSupport', () => {
  it('allows move, copy, mark read, star and tag on header conditions', () => {
    expect(retroactiveSupport(rule([{ field: 'from', comparator: 'address_is', value: 'a@b.c' }], [
      { type: 'mark_read' }, { type: 'star' }, { type: 'add_label', value: 'work' },
      { type: 'copy', value: 'A', mailboxId: 'a' }, { type: 'move', value: 'B', mailboxId: 'b' }, { type: 'stop' },
    ])).ok).toBe(true);
  });

  it('never runs forward, redirect, reject or discard on old mail', () => {
    for (const action of [
      { type: 'forward', value: 'x@y.z' },
      { type: 'reject', value: 'no' },
      { type: 'discard' },
    ] as FilterAction[]) {
      const r = rule([{ field: 'from', comparator: 'address_is', value: 'anna@acme.com' }], [{ type: 'mark_read' }, action]);
      expect(retroactiveSupport(r)).toEqual({ ok: false, reason: 'action' });
      expect(planRetroactive(r, [message()])).toEqual({ ids: [], steps: [] });
    }
  });

  it('never runs a rule with a period on old mail', () => {
    for (const period of [{ activeFrom: '2026-10-05T06:00:00.000Z' }, { activeUntil: '2026-10-16T16:00:00.000Z' }]) {
      const r = rule([{ field: 'from', comparator: 'address_is', value: 'anna@acme.com' }], [{ type: 'mark_read' }], period);
      expect(retroactiveSupport(r)).toEqual({ ok: false, reason: 'period' });
      expect(planRetroactive(r, [message()])).toEqual({ ids: [], steps: [] });
    }
  });

  it('refuses conditions it cannot evaluate like Sieve', () => {
    for (const condition of [
      { field: 'body', comparator: 'contains', value: 'x' },
      { field: 'size', comparator: 'greater_than', value: '100K' },
      { field: 'attachment', comparator: 'has_any', value: '' },
      { field: 'attachment', comparator: 'has_type', value: 'pdf' },
    ] as FilterCondition[]) {
      expect(retroactiveSupport(rule([condition]))).toEqual({ ok: false, reason: 'condition' });
    }
  });

  it('never runs a rule for all messages on old mail', () => {
    // It would act on everything in the folder, a "delete" on the whole inbox.
    const all = rule([{ field: 'all', comparator: 'any', value: '' }], [{ type: 'mark_read' }]);
    expect(retroactiveSupport(all)).toEqual({ ok: false, reason: 'condition' });
    expect(planRetroactive(all, [message()])).toEqual({ ids: [], steps: [] });
  });

  it('refuses a folder known only by its path, and keep', () => {
    expect(retroactiveSupport(rule([{ field: 'from', comparator: 'address_is', value: 'a@b.c' }], [{ type: 'move', value: 'News' }])).ok).toBe(false);
    expect(retroactiveSupport(rule([{ field: 'from', comparator: 'address_is', value: 'a@b.c' }], [{ type: 'keep' }])).ok).toBe(false);
  });
});

describe('planRetroactive', () => {
  const messages = [
    message({ id: 'inbox-unread' }),
    message({ id: 'already-there', mailboxIds: { news: true, inbox: true } }),
    message({ id: 'read', keywords: { $seen: true } }),
    message({ id: 'other', fromAddress: 'joanna@acme.com' }),
  ];

  it('moves what matches, leaving what is already in the target', () => {
    const plan = planRetroactive(sender('anna@acme.com'), messages);
    expect(plan.steps).toEqual([{ kind: 'move', ids: ['inbox-unread', 'read'], mailboxId: 'news' }]);
    expect(plan.ids.sort()).toEqual(['inbox-unread', 'read']);
  });

  it('counts only messages a step changes', () => {
    const plan = planRetroactive(rule([{ field: 'from', comparator: 'address_is', value: 'anna@acme.com' }], [{ type: 'mark_read' }]), messages);
    expect(plan.steps).toEqual([{ kind: 'mark_read', ids: ['inbox-unread', 'already-there'] }]);
    expect(plan.ids).toEqual(['inbox-unread', 'already-there']);
  });

  it('sets flags first and moves before adding copies', () => {
    const plan = planRetroactive(rule([{ field: 'from', comparator: 'address_is', value: 'anna@acme.com' }], [
      { type: 'copy', value: 'A', mailboxId: 'archive' },
      { type: 'move', value: 'News', mailboxId: 'news' },
      { type: 'add_label', value: 'work' },
      { type: 'star' },
    ]), [message()]);
    expect(plan.steps.map(s => s.kind)).toEqual(['keyword', 'keyword', 'move', 'copy']);
    expect(plan.steps[0]).toEqual({ kind: 'keyword', ids: ['m1'], keyword: '$label:work' });
    expect(plan.steps[1]).toEqual({ kind: 'keyword', ids: ['m1'], keyword: '$flagged' });
    expect(plan.steps[3]).toEqual({ kind: 'copy', ids: ['m1'], mailboxId: 'archive' });
  });

  it('blocks into Junk, spam or not', () => {
    const block = rule([{ field: 'from', comparator: 'address_is', value: 'anna@acme.com' }], [{ type: 'move', value: 'Junk', mailboxId: 'junk' }], { includeSpam: true });
    const plan = planRetroactive(block, [message({ keywords: { $junk: true } })]);
    expect(plan.steps).toEqual([{ kind: 'move', ids: ['m1'], mailboxId: 'junk' }]);
  });
});

describe('planRetroactive, who it plans', () => {
  it('only plans matching messages', () => {
    const plan = planRetroactive(sender('anna@acme.com'), [
      message({ id: 'yes' }),
      message({ id: 'no', fromAddress: 'joanna@acme.com' }),
      message({ id: 'no2', fromAddress: 'bob@other.org' }),
    ]);
    expect(plan.ids).toEqual(['yes']);
    expect(plan.steps).toEqual([{ kind: 'move', ids: ['yes'], mailboxId: 'news' }]);
  });

  it('skips a junk-keyword message unless includeSpam', () => {
    const junk = message({ id: 'junk', keywords: { $junk: true } });
    const clean = message({ id: 'clean' });
    expect(planRetroactive(sender('anna@acme.com'), [junk, clean]).ids).toEqual(['clean']);
    const optIn = rule([{ field: 'from', comparator: 'address_is', value: 'anna@acme.com' }], undefined, { includeSpam: true });
    expect(planRetroactive(optIn, [junk, clean]).ids.sort()).toEqual(['clean', 'junk']);
  });
});

describe('retroQueryFilter', () => {
  it('narrows exact senders with the JMAP from filter, one per value', () => {
    expect(retroQueryFilter(sender(['anna@acme.com', 'bob@acme.com']), 'inbox')).toEqual({
      operator: 'AND',
      conditions: [
        { inMailbox: 'inbox' },
        { operator: 'OR', conditions: [{ from: 'anna@acme.com' }, { from: 'bob@acme.com' }] },
      ],
    });
  });

  it('leaves header conditions to the client, since the header filter finds nothing on Stalwart', () => {
    const r = rule([{ field: 'header', headerName: 'List-Id', comparator: 'contains', value: 'news.acme.com' }]);
    expect(retroQueryFilter(r, 'inbox')).toEqual({ inMailbox: 'inbox' });
    const both = rule([
      { field: 'from', comparator: 'address_is', value: 'anna@acme.com' },
      { field: 'header', headerName: 'List-Id', comparator: 'contains', value: 'news.acme.com' },
    ]);
    expect(retroQueryFilter(both, 'inbox')).toEqual({ operator: 'AND', conditions: [{ inMailbox: 'inbox' }, { from: 'anna@acme.com' }] });
  });

  it('does not narrow by full-text search where it could miss a Sieve substring', () => {
    const r = rule([{ field: 'subject', comparator: 'contains', value: 'voice' }]);
    expect(retroQueryFilter(r, 'inbox')).toEqual({ inMailbox: 'inbox' });
    const either = rule([
      { field: 'from', comparator: 'address_is', value: 'anna@acme.com' },
      { field: 'subject', comparator: 'contains', value: 'x' },
    ], undefined, { matchType: 'any' });
    expect(retroQueryFilter(either, 'inbox')).toEqual({ inMailbox: 'inbox' });
  });
});

describe('retroProperties and toRetroMessage', () => {
  it('asks for the parsed address or the decoded header each condition needs', () => {
    const r = rule([
      { field: 'from', comparator: 'address_is', value: 'a@b.c' },
      { field: 'subject', comparator: 'contains', value: 'x' },
      { field: 'header', headerName: 'List-Id', comparator: 'contains', value: 'y' },
    ]);
    expect(retroProperties(r)).toEqual([
      'mailboxIds', 'keywords', 'from',
      'header:Subject:asText:all', 'header:Subject:all',
      'header:List-Id:asText:all', 'header:List-Id:all',
    ]);
  });

  it('falls back to the raw header where the server has no text form (Stalwart and List-Id)', () => {
    const message = toRetroMessage({
      id: 'e1',
      'header:List-Id:asText:all': [null],
      'header:List-Id:all': [' Rules live list\r\n <rules-live.example.org>'],
    });
    expect(message.headers['list-id']).toEqual(['Rules live list <rules-live.example.org>']);
    const r = rule([{ field: 'header', headerName: 'List-Id', comparator: 'contains', value: 'rules-live.example.org' }]);
    expect(ruleMatches(r, message)).toBe(true);
  });

  it('maps an Email/get record', () => {
    expect(toRetroMessage({
      id: 'e1',
      mailboxIds: { inbox: true },
      keywords: { $seen: true },
      from: [{ name: 'A', email: 'a@b.c' }],
      'header:List-Id:asText:all': ['x <y>'],
      'header:Subject:asText:all': null,
    })).toEqual({
      id: 'e1',
      mailboxIds: { inbox: true },
      keywords: { $seen: true },
      from: [{ name: 'A', email: 'a@b.c' }],
      to: undefined,
      cc: undefined,
      headers: { 'list-id': ['x <y>'], subject: [] },
    });
  });
});
