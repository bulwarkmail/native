import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../lib/sieve/retroactive-run', () => ({ executeRetroPlan: vi.fn() }));
vi.mock('../../../api/jmap-client', () => ({ jmapClient: { accountId: 'own' } }));

import { renderHook } from '../../email/structured-mail/__tests__/render-native';
import { translate } from '../../../i18n';
import type { Mailbox } from '../../../api/types';
import type { FilterRule } from '../../../lib/sieve/types';
import { generateScript } from '../../../lib/sieve/generator';
import { parseScript } from '../../../lib/sieve/parser';
import { STALWART_EXTENSIONS } from '../../../lib/sieve/__tests__/fixtures/webmail';
import { CONDITION_KINDS, SIZE_UNITS, useRuleEditor, type RuleEditorOptions, type RuleEditorState } from '../use-rule-editor';
import type { ChecklistKey } from '../../../lib/sieve/rule-editor-model';

const t = ((key: string, fallback?: string, params?: Record<string, unknown>) => translate('en', key, fallback, params as never)) as RuleEditorOptions['t'];

const mailboxes = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null },
  { id: 'trash', name: 'Trash', role: 'trash', parentId: null },
  { id: 'junk', name: 'Junk', role: 'junk', parentId: null },
  { id: 'news', name: 'Newsletters', role: null, parentId: null },
  { id: 'work', name: 'Work', role: null, parentId: null },
  { id: 'proj', name: 'Projects', role: null, parentId: 'work' },
  { id: 'odd', name: 'Spaces & Ümlauts "quoted" \\ slash/ish', role: null, parentId: null },
].map((m) => ({ myRights: { mayAddItems: true }, isShared: false, sortOrder: 0, totalEmails: 0, unreadEmails: 0, ...m })) as unknown as Mailbox[];

const NASTY = [
  '', ' ', 'a', 'news@acme.example', 'acme.example', 'x@y', 'a, b,, c', ',', 'Ärger', '🎉', '"quoted"', 'back\\slash',
  '*?', '[', '(', '.*', 'a{2,}', '$', '\n', 'a'.repeat(300), '*/ require "x";', '0', '-5', '99999999999', '1.5', '2M',
  'me@elsewhere.example', 'me@elsewhere.example, you@there.example', 'not an address', 'X-Spam-Flag', 'List-Id', 'Bad:Header',
  '2026-11-20 10:00', '2026-01-01 00:00', '9999-12-31 23:59', 'garbage',
];

const CHECKS: ChecklistKey[] = ['markRead', 'star', 'tag', 'copy', 'move', 'forward', 'keep', 'reject', 'discard'];

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const STARTS: (FilterRule | undefined)[] = [
  undefined,
  {
    id: 'r1', name: 'Statements', enabled: true, matchType: 'all',
    conditions: [{ field: 'from', comparator: 'contains', value: 'northbank' }],
    actions: [{ type: 'mark_read' }, { type: 'move', value: 'Newsletters', mailboxId: 'news' }], stopProcessing: true,
  },
  {
    id: 'r2', name: 'Mixed', enabled: false, matchType: 'any',
    conditions: [
      { field: 'size', comparator: 'greater_than', value: '5M' },
      { field: 'header', comparator: 'contains', value: 'codehub', headerName: 'List-Id' },
      { field: 'attachment', comparator: 'has_type', value: 'pdf' },
    ],
    actions: [{ type: 'forward', value: 'a@b.example', keepCopy: true }, { type: 'add_label', value: 'work' }, { type: 'stop' }],
    stopProcessing: false, activeFrom: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'r3', name: 'Gone folder', enabled: true, matchType: 'all',
    conditions: [{ field: 'subject', comparator: 'regex', value: '^\\[URGENT\\]' }],
    actions: [{ type: 'copy', value: 'Deleted/Folder' }, { type: 'discard' }, { type: 'reject', value: 'nope' }, { type: 'keep' }],
    stopProcessing: false,
  },
];

function poke(s: RuleEditorState, rnd: () => number): void {
  const pick = <T,>(list: readonly T[]) => list[Math.floor(rnd() * list.length)];
  const row = pick(s.conditionRows);
  const steps: Array<() => void> = [
    () => s.setName(pick(NASTY)),
    () => s.setMatchType(pick(['all', 'any'] as const)),
    () => s.conditionActions.setKind(row.index, pick(CONDITION_KINDS)),
    () => { if (row.comparators.length) s.conditionActions.setComparator(row.index, pick(row.comparators)); },
    () => s.conditionActions.setText(row.index, pick(NASTY)),
    () => s.conditionActions.commitText(row.index),
    () => s.conditionActions.setHeaderName(row.index, pick(NASTY)),
    () => s.conditionActions.setSizeAmount(row.index, pick(NASTY).replace(/[^\d]/g, '')),
    () => s.conditionActions.setSizeUnit(row.index, pick(SIZE_UNITS)),
    () => s.conditionActions.add(),
    () => s.conditionActions.remove(row.index),
    () => s.actionControls.toggle(pick(CHECKS), rnd() < 0.6),
    () => s.actionControls.toggleTag(pick(['work', 'family', 'gone'])),
    () => s.actionControls.pickFolder(pick(['move', 'copy'] as const), pick(mailboxes).id),
    () => s.actionControls.setForwardTo(pick(NASTY)),
    () => s.actionControls.setForwardKeepCopy(rnd() < 0.5),
    () => s.actionControls.setRejectMessage(pick(NASTY)),
    () => s.setContinue(rnd() < 0.5),
    () => s.setSkip(rnd() < 0.5),
    () => s.setIncludeSpam(rnd() < 0.5),
    () => { if (s.periodShown) s.setPeriodOn(rnd() < 0.5); },
    () => s.setPeriodStart(pick(NASTY)),
    () => s.setPeriodEnd(pick(NASTY)),
    () => { s.setApplyTo(s.applyOptions.length ? pick(s.applyOptions).value : 'new'); },
  ];
  pick(steps)();
}

function checkSaved(rule: FilterRule, seed: number): void {
  expect(rule.conditions.length, `seed ${seed}: conditions`).toBeGreaterThan(0);
  expect(rule.actions.length, `seed ${seed}: actions`).toBeGreaterThan(0);
  const types = rule.actions.map((a) => a.type);
  const deletes = types.includes('discard') || types.includes('reject');
  const files = types.includes('move') || types.includes('copy') || types.includes('keep');
  expect(deletes && files, `seed ${seed}: deletes and files ${types.join(',')}`).toBe(false);
  expect(types.includes('discard') && types.includes('reject'), `seed ${seed}: discard and reject`).toBe(false);
  for (const a of rule.actions) {
    if (a.type === 'forward') expect(a.value, `seed ${seed}: forward address`).toMatch(/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/);
    if (a.type === 'move' || a.type === 'copy') expect(a.mailboxId || a.value, `seed ${seed}: folder`).toBeTruthy();
    if (a.type === 'add_label') expect(a.value, `seed ${seed}: tag`).toBeTruthy();
  }
  for (const c of rule.conditions) {
    if (c.field !== 'all' && !(c.field === 'attachment' && c.comparator === 'has_any')) {
      const list = Array.isArray(c.value) ? c.value : [c.value];
      expect(list.length > 0 && list.every((v) => v.trim().length > 0), `seed ${seed}: empty value ${JSON.stringify(c)}`).toBe(true);
    }
    if (c.field === 'size') expect(c.value, `seed ${seed}: size`).toMatch(/^\d+[KMG]?$/);
    if (c.field === 'header') expect(c.headerName, `seed ${seed}: header`).toMatch(/^[\x21-\x39\x3b-\x7e]+$/);
  }
  expect(rule.name.trim().length, `seed ${seed}: name`).toBeGreaterThan(0);
  const script = generateScript([rule], undefined, { extensions: STALWART_EXTENSIONS });
  const parsed = parseScript(script);
  expect(parsed.isOpaque, `seed ${seed}: opaque`).toBe(false);
  expect(parsed.rules.map((r) => r.id), `seed ${seed}: round trip`).toEqual([rule.id]);
}

describe('the rule editor under random taps', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: false }));
  afterEach(() => vi.useRealTimers());

  const SEEDS = Number(process.env.RULE_MONKEY_SEEDS ?? 60);
  const STEPS = Number(process.env.RULE_MONKEY_STEPS ?? 80);

  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`survives ${STEPS} random steps and then saves a valid rule or says why not (seed ${seed})`, async () => {
      const rnd = prng(seed);
      const onSave = vi.fn();
      const start = STARTS[seed % STARTS.length];
      const confirmTrash = vi.fn(async () => rnd() < 0.5);
      const editor = renderHook(() => useRuleEditor({
        rule: seed % 3 === 0 ? start : undefined,
        initialRule: seed % 3 === 1 ? start : undefined,
        mailboxes,
        keywords: [{ id: 'work', label: 'Work' }, { id: 'family', label: 'Family' }],
        t,
        maxRedirects: seed % 4 === 0 ? 1 : seed % 4 === 1 ? 0 : null,
        forwardsBefore: seed % 5 === 0 ? 1 : 0,
        periodsSupported: seed % 2 === 0,
        regexSupported: seed % 3 !== 2,
        offerApplyToExisting: true,
        applyExistingFolder: 'Inbox',
        previewMatches: async () => (rnd() < 0.2 ? null : { items: [], total: Math.floor(rnd() * 5), complete: rnd() < 0.5, inFolder: Math.floor(rnd() * 3) }),
        confirmTrash,
        onSave,
      }));
      for (let step = 0; step < STEPS; step++) {
        if (rnd() < 0.08) {
          await vi.advanceTimersByTimeAsync(600);
          continue;
        }
        if (rnd() < 0.06) {
          await editor.current.save();
          continue;
        }
        poke(editor.current, rnd);
      }
      await vi.advanceTimersByTimeAsync(600);
      const savedBefore = onSave.mock.calls.length;
      const ok = await editor.current.save();
      for (const [rule, options] of onSave.mock.calls) {
        checkSaved(rule as FilterRule, seed);
        expect(['new', 'folder', 'all']).toContain((options as { applyTo: string }).applyTo);
      }
      if (!ok && onSave.mock.calls.length === savedBefore && confirmTrash.mock.calls.length === 0) {
        expect(Object.values(editor.current.errors).some(Boolean), `seed ${seed}: refused without saying why`).toBe(true);
      }
      editor.unmount();
    });
  }
});
