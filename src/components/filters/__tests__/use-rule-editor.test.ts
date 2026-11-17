import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../lib/sieve/retroactive-run', () => ({ executeRetroPlan: vi.fn() }));
vi.mock('../../../api/jmap-client', () => ({ jmapClient: { accountId: 'own' } }));

import { renderHook } from '../../email/structured-mail/__tests__/render-native';
import { translate } from '../../../i18n';
import type { Mailbox } from '../../../api/types';
import type { FilterRule } from '../../../lib/sieve/types';
import type { RulePreview } from '../../../lib/sieve/rule-preview';
import { generateScript } from '../../../lib/sieve/generator';
import { useRuleEditor, type RuleEditorOptions, type RuleEditorState } from '../use-rule-editor';

const t = ((key: string, fallback?: string, params?: Record<string, unknown>) => translate('en', key, fallback, params as never)) as RuleEditorOptions['t'];

function existing(overrides: Partial<FilterRule> = {}): FilterRule {
  return {
    id: 'rule-1',
    name: 'Statements',
    enabled: true,
    matchType: 'all',
    conditions: [{ field: 'from', comparator: 'contains', value: 'revolut.com' }],
    actions: [{ type: 'mark_read' }],
    stopProcessing: false,
    ...overrides,
  };
}

const folders = [
  { id: 'inbox', name: 'Inbox', role: 'inbox', parentId: null },
  { id: 'news', name: 'News', role: null, parentId: null },
  { id: 'archive', name: 'Archive', role: 'archive', parentId: null },
  { id: 'work', name: 'Work', role: null, parentId: null },
  { id: 'acme', name: 'Acme', role: null, parentId: 'work' },
  { id: 'trash', name: 'Deleted Items', role: 'trash', parentId: null },
].map((m) => ({ sortOrder: 0, totalEmails: 0, unreadEmails: 0, myRights: { mayAddItems: true }, ...m })) as unknown as Mailbox[];

function open(options: Partial<RuleEditorOptions> = {}) {
  const onSave = vi.fn();
  const editor = renderHook(() => useRuleEditor({ mailboxes: [], keywords: [], t, onSave, ...options }));
  return {
    editor,
    get state(): RuleEditorState { return editor.current; },
    onSave,
    saved: (n = 0) => onSave.mock.calls[n][0] as FilterRule,
  };
}

function previewOf(result: Partial<RulePreview>) {
  return vi.fn().mockResolvedValue({ items: [], total: 0, complete: true, ...result });
}

async function settle() {
  await vi.advanceTimersByTimeAsync(600);
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: false }));
afterEach(() => vi.useRealTimers());

describe('a user making a rule on the phone', () => {
  it('gets a rule from the ticked actions, named after what it does when the name is left empty', async () => {
    const r = open();
    r.state.conditionActions.setText(0, 'news@acme.com');
    r.state.actionControls.toggle('markRead', true);
    r.state.actionControls.toggle('star', true);
    expect(await r.state.save()).toBe(true);
    expect(r.saved().actions).toEqual([{ type: 'mark_read' }, { type: 'star' }]);
    expect(r.saved().conditions).toEqual([{ field: 'from', comparator: 'contains', value: 'news@acme.com' }]);
    expect(r.saved().name).toBe('From news@acme.com → Mark as read, Star message');
  });

  it('sees the name the rule will get while the name is empty', () => {
    const r = open();
    expect(r.state.autoName).toBe('New rule');
    r.state.conditionActions.setText(0, 'a@b.example');
    r.state.actionControls.toggle('star', true);
    expect(r.state.autoName).toBe('From a@b.example → Star message');
    r.state.setName('Mine');
    expect(r.state.autoName).toBe('From a@b.example → Star message');
  });

  it('opens a rule with its actions ticked', () => {
    const r = open({ rule: existing({ actions: [{ type: 'star' }] }) });
    expect(r.state.checklist.star).toBe(true);
    expect(r.state.checklist.markRead).toBe(false);
  });

  it('cannot also move the message when the rule discards it', () => {
    const r = open({ rule: existing({ actions: [{ type: 'discard' }] }) });
    expect(r.state.blocked.has('move')).toBe(true);
    r.state.actionControls.toggle('move', true);
    expect(r.state.checklist.move.on).toBe(false);
  });

  it('stops later rules when "Continue to apply other rules" is unticked, and can skip the rule', async () => {
    const r = open({ rule: existing() });
    r.state.setContinue(false);
    r.state.setSkip(true);
    await r.state.save();
    expect(r.saved()).toMatchObject({ stopProcessing: true, enabled: false, name: 'Statements' });
  });

  it('finds "Has an attachment" as a condition of its own, without a comparison or a value', async () => {
    const r = open({ rule: existing() });
    r.state.conditionActions.setKind(0, 'attachment_any');
    expect(r.state.conditionRows[0].comparators).toEqual([]);
    expect(r.state.conditionRows[0].takesValue).toBe(false);
    expect(r.state.conditionRows[0].kindLabel).toBe('Has an attachment');
    await r.state.save();
    expect(r.saved().conditions).toEqual([{ field: 'attachment', comparator: 'has_any', value: '' }]);
  });

  it('numbers the conditions and names each one for a screen reader', () => {
    const r = open({ rule: existing() });
    r.state.conditionActions.add();
    expect(r.state.conditionRows.map((row) => row.index + 1)).toEqual([1, 2]);
    expect(t('settings.filters.editor.condition_number', undefined, { number: 2 })).toBe('Condition 2');
  });

  it('reads "If all/any of these conditions apply" and switches between all and any', async () => {
    const r = open({ rule: existing() });
    expect([t('settings.filters.editor.if'), t('settings.filters.editor.match_all'), t('settings.filters.editor.of_conditions')].join(' '))
      .toBe('If all of these conditions apply');
    r.state.setMatchType('any');
    await r.state.save();
    expect(r.saved().matchType).toBe('any');
  });

  it('enters sizes in KB and MB', async () => {
    const r = open({ rule: existing() });
    r.state.conditionActions.setKind(0, 'size');
    r.state.conditionActions.setSizeAmount(0, '5');
    r.state.conditionActions.setSizeUnit(0, 'M');
    expect(r.state.conditionRows[0].size).toEqual({ amount: '5', unit: 'M' });
    await r.state.save();
    expect(r.saved().conditions).toEqual([{ field: 'size', comparator: 'greater_than', value: '5M' }]);
  });

  it('keeps a comma list as several values once the field is left', () => {
    const r = open();
    r.state.conditionActions.setText(0, 'a@x.example, b@y.example,');
    expect(r.state.conditionRows[0].text).toBe('a@x.example, b@y.example,');
    r.state.conditionActions.commitText(0);
    expect(r.state.conditionRows[0].condition.value).toEqual(['a@x.example', 'b@y.example']);
  });

  it('has a short placeholder, with the note that commas give several values', () => {
    const r = open({ rule: existing() });
    expect(r.state.conditionRows[0].placeholder).toBe('Value');
    expect(r.state.conditionRows[0].hint).toBe('To match several values, separate them with commas.');
  });
});

describe('the live preview', () => {
  it('shows the mail the rule would catch while the conditions are typed', async () => {
    const previewMatches = previewOf({
      items: [{ id: 'm1', from: 'Revolut', subject: 'Your account statement is available', receivedAt: '2026-11-03T00:00:00Z' }],
      total: 1,
    });
    const r = open({ rule: existing(), previewMatches });
    expect(r.state.previewText).toBe('Looking for matching mail…');
    await settle();
    expect(r.state.previewText).toBe('1 message matches');
    expect(previewMatches.mock.calls[0][0].conditions).toEqual([{ field: 'from', comparator: 'contains', value: 'revolut.com' }]);
    expect(r.state.previewState).toMatchObject({ status: 'done', result: { items: [{ subject: 'Your account statement is available' }] } });
  });

  it('asks again only once the typing stops', async () => {
    const previewMatches = previewOf({ total: 2 });
    const r = open({ previewMatches });
    r.state.conditionActions.setText(0, 'n');
    await vi.advanceTimersByTimeAsync(200);
    r.state.conditionActions.setText(0, 'no');
    await vi.advanceTimersByTimeAsync(200);
    r.state.conditionActions.setText(0, 'north');
    await settle();
    expect(previewMatches).toHaveBeenCalledTimes(1);
    expect(previewMatches.mock.calls[0][0].conditions[0].value).toBe('north');
  });

  it('says only recent mail was looked at when the scan stopped early', async () => {
    const r = open({ rule: existing(), previewMatches: previewOf({ total: 0, complete: false }) });
    await settle();
    expect(r.state.previewText).toBe('No recent messages match');
  });

  it('leaves out mail marked as spam for a rule that files mail', async () => {
    const previewMatches = previewOf({ total: 1 });
    open({ rule: existing({ actions: [{ type: 'move', mailboxId: 'news', value: 'News' }] }), mailboxes: folders, previewMatches });
    await settle();
    expect(previewMatches.mock.calls[0][1]).toEqual({ skipJunk: true });
  });

  it('says a "Delivered to" rule is for new mail only, with no preview and no Apply to (#726)', async () => {
    const previewMatches = previewOf({ total: 7, inFolder: 3 });
    const r = open({
      rule: existing({ conditions: [{ field: 'delivered_to', comparator: 'address_is', value: 'shop@example.com' }] }),
      previewMatches, offerApplyToExisting: true, applyExistingFolder: 'Inbox',
    });
    expect(r.state.newMailOnly).toBe(true);
    expect(t('settings.filters.editor.delivered_to_new_only')).toMatch(/new mail only/);
    await settle();
    expect(previewMatches).not.toHaveBeenCalled();
    expect(r.state.previewText).toBeNull();
    expect(r.state.applyOptions).toEqual([]);
  });

  it('has no preview for a regex that would not compile', async () => {
    const previewMatches = previewOf({ total: 1 });
    open({ rule: existing({ conditions: [{ field: 'subject', comparator: 'regex', value: '(unclosed' }] }), previewMatches, regexSupported: true });
    await settle();
    expect(previewMatches).not.toHaveBeenCalled();
  });
});

describe('Apply to', () => {
  const offer = (preview: Partial<RulePreview>, overrides: Partial<RuleEditorOptions> = {}) =>
    open({ rule: existing(), previewMatches: previewOf(preview), offerApplyToExisting: true, applyExistingFolder: 'Inbox', ...overrides });

  it('offers the Inbox or all mail, saying how many messages each covers', async () => {
    const r = offer({ total: 7, inFolder: 3 });
    await settle();
    expect(r.state.applyOptions.map((o) => o.label)).toEqual(['New mail only', 'New mail and Inbox (3)', 'New mail and all mail (7)']);
    expect(r.state.effectiveApply).toBe('new');
    r.state.setApplyTo('all');
    await r.state.save();
    expect(r.onSave.mock.calls[0][1]).toEqual({ applyTo: 'all' });
  });

  it('marks a count as a lower bound when not all mail was looked at', async () => {
    const r = offer({ total: 1000, complete: false, inFolder: 40 });
    await settle();
    expect(r.state.applyOptions.map((o) => o.label)).toEqual(['New mail only', 'New mail and Inbox (40+)', 'New mail and all mail (1000+)']);
  });

  it('still offers applying, without counts, when the scan stopped early and found nothing', async () => {
    const r = offer({ total: 0, complete: false, inFolder: 0 });
    await settle();
    expect(r.state.applyOptions.map((o) => o.label)).toEqual(['New mail only', 'New mail and Inbox', 'New mail and all mail']);
  });

  it('greys out the folder when none of its mail matches', async () => {
    const r = offer({ total: 4, inFolder: 0 });
    await settle();
    expect(r.state.applyOptions.find((o) => o.value === 'folder')?.disabled).toBe(true);
    r.state.setApplyTo('folder');
    expect(r.state.effectiveApply).toBe('new');
  });

  it('is not offered when nothing matches', async () => {
    const r = offer({ total: 0, inFolder: 0 });
    await settle();
    expect(r.state.applyOptions).toEqual([]);
  });

  it('is not offered for a rule that only forwards, so old mail is never sent on', async () => {
    const r = offer({ total: 7, inFolder: 3 }, { rule: existing({ actions: [{ type: 'forward', value: 'me@elsewhere.example' }] }) });
    await settle();
    expect(r.state.previewText).toBe('7 messages match');
    expect(r.state.applyOptions).toEqual([]);
  });

  describe('for a rule that discards', () => {
    const discarding = (preview: Partial<RulePreview>, answer: boolean) => {
      const confirmTrash = vi.fn().mockResolvedValue(answer);
      const r = offer(preview, { rule: existing({ actions: [{ type: 'discard' }] }), confirmTrash });
      return { r, confirmTrash };
    };

    it('asks first, naming how many messages go to Trash, and saves only when confirmed', async () => {
      const { r, confirmTrash } = discarding({ total: 7, inFolder: 3 }, true);
      await settle();
      r.state.setApplyTo('folder');
      expect(await r.state.save()).toBe(true);
      expect(confirmTrash).toHaveBeenCalledWith({
        title: 'Move existing mail to Trash?',
        message: 'This moves 3 existing messages to Trash.',
        confirm: 'Save and move to Trash',
        cancel: 'Cancel',
      });
      expect(r.onSave.mock.calls[0][1]).toEqual({ applyTo: 'folder' });
    });

    it('does not save when the question is cancelled', async () => {
      const { r, confirmTrash } = discarding({ total: 1, inFolder: 1 }, false);
      await settle();
      r.state.setApplyTo('all');
      expect(await r.state.save()).toBe(false);
      expect(confirmTrash.mock.calls[0][0].message).toBe('This moves 1 existing message to Trash.');
      expect(r.onSave).not.toHaveBeenCalled();
    });

    it('says the count is a lower bound when the scan stopped early', async () => {
      const { r, confirmTrash } = discarding({ total: 1000, complete: false, inFolder: 40 }, true);
      await settle();
      r.state.setApplyTo('all');
      await r.state.save();
      expect(confirmTrash.mock.calls[0][0].message).toBe('This moves 1,000+ existing messages to Trash.');
    });

    it('does not ask when the rule is for new mail only', async () => {
      const { r, confirmTrash } = discarding({ total: 7, inFolder: 3 }, true);
      await settle();
      await r.state.save();
      expect(confirmTrash).not.toHaveBeenCalled();
      expect(r.onSave).toHaveBeenCalledWith(expect.objectContaining({ actions: [{ type: 'discard' }] }), { applyTo: 'new' });
    });
  });

  it('does not ask before applying a rule that does not discard', async () => {
    const confirmTrash = vi.fn();
    const r = offer({ total: 7, inFolder: 3 }, { confirmTrash });
    await settle();
    r.state.setApplyTo('all');
    await r.state.save();
    expect(confirmTrash).not.toHaveBeenCalled();
    expect(r.onSave).toHaveBeenCalledWith(expect.anything(), { applyTo: 'all' });
  });
});

describe('what the editor will not save', () => {
  it('treats a value of only commas as empty instead of saving a rule the server rejects', async () => {
    const r = open();
    r.state.conditionActions.setText(0, ' , ,');
    r.state.actionControls.toggle('star', true);
    expect(await r.state.save()).toBe(false);
    expect(r.onSave).not.toHaveBeenCalled();
    expect(r.state.errors.conditions).toBe('At least one condition with a value is required');
    expect(r.state.firstError).toBe('conditions');
    expect(r.state.conditionRows[0].invalid).toBe(true);
  });

  it('refuses an attachment type that names no extension, such as .*', async () => {
    const r = open({ rule: existing() });
    r.state.conditionActions.setKind(0, 'attachment_type');
    r.state.conditionActions.setText(0, '.*');
    await r.state.save();
    expect(r.onSave).not.toHaveBeenCalled();
    expect(r.state.errors.conditions).toBe('Enter a file extension, such as pdf');
    expect(r.state.conditionRows[0].invalid).toBe(true);
  });

  it('asks to untick one of two contradicting actions carried over from an older rule', async () => {
    const r = open({ rule: existing({ actions: [{ type: 'move', value: 'News', mailboxId: 'news' }, { type: 'discard' }] }), mailboxes: folders });
    await r.state.save();
    expect(r.onSave).not.toHaveBeenCalled();
    expect(r.state.errors.actions).toBe('Discard and Reject cannot be combined with Move, Copy or Keep, or with each other');
    r.state.actionControls.toggle('discard', false);
    expect(r.state.errors.actions).toBeNull();
    await r.state.save();
    expect(r.saved().actions).toEqual([{ type: 'move', value: 'News', mailboxId: 'news' }]);
  });

  it('says what is missing instead of saving a rule that does nothing', async () => {
    const r = open();
    r.state.conditionActions.setText(0, 'x');
    await r.state.save();
    expect(r.onSave).not.toHaveBeenCalled();
    expect(r.state.errors.actions).toBe('At least one action is required');
    expect(r.state.firstError).toBe('actions');
  });

  it('shows no error before the first save', () => {
    const r = open();
    expect(r.state.errors).toEqual({ conditions: null, actions: null, period: null });
    expect(r.state.firstError).toBeNull();
  });

  it.each(['X-Spam Flag', 'X-Foo.Bar', ''])('blocks the header name %j', async (headerName) => {
    const r = open({ rule: existing({ conditions: [{ field: 'header', headerName, comparator: 'contains', value: 'yes' }] }) });
    await r.state.save();
    expect(r.onSave).not.toHaveBeenCalled();
    expect(r.state.errors.conditions).toBe(t('settings.filters.validation_header_name'));
    expect(r.state.errors.conditions).toMatch(/^Enter a header name/);
    expect(r.state.conditionRows[0].headerInvalid).toBe(true);
  });

  it('saves a valid header name, trimmed', async () => {
    const r = open({ rule: existing({ conditions: [{ field: 'header', headerName: ' X-Spam_Flag-2 ', comparator: 'contains', value: 'yes' }] }) });
    await r.state.save();
    expect(r.saved().conditions).toEqual([{ field: 'header', comparator: 'contains', value: 'yes', headerName: 'X-Spam_Flag-2' }]);
  });

  it('points at the folder when Move is ticked without one, and saves once a folder is picked', async () => {
    const r = open({ mailboxes: folders });
    r.state.conditionActions.setText(0, 'news@example.com');
    r.state.actionControls.toggle('move', true);
    await r.state.save();
    expect(r.onSave).not.toHaveBeenCalled();
    expect(r.state.errors.actions).toBe('Select a folder for this action');
    expect(r.state.actionInvalid('move')).toBe(true);
    r.state.actionControls.pickFolder('move', 'news');
    expect(r.state.errors.actions).toBeNull();
    await r.state.save();
    expect(r.saved().actions).toEqual([{ type: 'move', mailboxId: 'news', value: 'News' }]);
  });

  it('marks the empty condition and the folder together', async () => {
    const r = open({ mailboxes: folders });
    r.state.actionControls.toggle('move', true);
    await r.state.save();
    expect(r.state.conditionRows[0].invalid).toBe(true);
    expect(r.state.actionInvalid('move')).toBe(true);
    expect([r.state.errors.conditions, r.state.errors.actions]).toEqual(['At least one condition with a value is required', 'Select a folder for this action']);
    r.state.conditionActions.setText(0, 'news@example.com');
    expect(r.state.conditionRows[0].invalid).toBe(false);
  });

  it('does not save a copy left without its folder next to a move that has one', async () => {
    const r = open({ mailboxes: folders });
    r.state.conditionActions.setText(0, 'news@example.com');
    r.state.actionControls.pickFolder('move', 'news');
    r.state.actionControls.toggle('copy', true);
    await r.state.save();
    expect(r.onSave).not.toHaveBeenCalled();
    expect([r.state.actionInvalid('move'), r.state.actionInvalid('copy')]).toEqual([false, true]);
  });

  it('wants a valid address to forward to', async () => {
    const r = open({ rule: existing() });
    r.state.actionControls.setForwardTo('not an address');
    expect(r.state.checklist.forward.on).toBe(true);
    await r.state.save();
    expect(r.state.errors.actions).toBe('Enter an address to forward to');
    r.state.actionControls.setForwardTo('a@x.example, b@y.example');
    await r.state.save();
    expect(r.saved().actions).toEqual([
      { type: 'mark_read' },
      { type: 'forward', value: 'a@x.example', keepCopy: true },
      { type: 'forward', value: 'b@y.example', keepCopy: true },
    ]);
  });
});

describe('the folder picker', () => {
  it('shows the whole path of a subfolder, and role folders as the sidebar names them', () => {
    const r = open({ rule: existing({ actions: [{ type: 'move', value: 'Work/Acme', mailboxId: 'acme' }] }), mailboxes: folders });
    expect(r.state.folderLabel(r.state.checklist.move)).toBe('Work / Acme');
    r.state.actionControls.pickFolder('copy', 'trash');
    expect(r.state.folderLabel(r.state.checklist.copy)).toBe('Trash');
  });

  it('still writes the server path into the rule', async () => {
    const r = open({ rule: existing({ actions: [] }), mailboxes: folders });
    r.state.actionControls.pickFolder('move', 'trash');
    await r.state.save();
    expect(r.saved().actions).toEqual([{ type: 'move', mailboxId: 'trash', value: 'Deleted Items' }]);
  });

  it('keeps a folder a rule files into that is no longer there', () => {
    const r = open({ rule: existing({ actions: [{ type: 'move', value: 'Old/Gone' }] }), mailboxes: folders });
    expect(r.state.folderLabel(r.state.checklist.move)).toBe('Old / Gone');
  });

  it('offers to also move spam only while the rule files mail', () => {
    const r = open({ rule: existing(), mailboxes: folders });
    expect(r.state.filing).toBe(false);
    r.state.actionControls.pickFolder('move', 'news');
    expect(r.state.filing).toBe(true);
  });
});

describe('tags', () => {
  const keywords = [{ id: 'work', label: 'Work' }, { id: 'family', label: 'Family' }];

  it('ticks Add tag with the first tag picked and unticks it with the last one', () => {
    const r = open({ rule: existing(), keywords });
    r.state.actionControls.toggleTag('family');
    expect(r.state.checklist.tag).toEqual({ on: true, ids: ['family'] });
    r.state.actionControls.toggleTag('family');
    expect(r.state.checklist.tag).toEqual({ on: false, ids: [] });
  });

  it('wants a tag when Add tag is ticked', async () => {
    const r = open({ rule: existing(), keywords });
    r.state.actionControls.toggle('tag', true);
    await r.state.save();
    expect(r.state.errors.actions).toBe('Select a tag for this action');
  });

  it('names the tags in the automatic name', () => {
    const r = open({ keywords });
    r.state.conditionActions.setText(0, 'boss@x.example');
    r.state.actionControls.toggleTag('work');
    expect(r.state.autoName).toBe('From boss@x.example → Work');
  });

  it('is not shown without tags unless the rule has one', () => {
    expect(open({ rule: existing() }).state.showsTagRow).toBe(false);
    expect(open({ rule: existing({ actions: [{ type: 'add_label', value: 'old' }] }) }).state.showsTagRow).toBe(true);
  });
});

describe('stopping later rules', () => {
  it('folds an old "stop" action into the checkbox and saves it that way', async () => {
    const r = open({ rule: existing({ actions: [{ type: 'move', value: 'Work', mailboxId: 'work' }, { type: 'stop' }] }), mailboxes: folders });
    expect(r.state.stopProcessing).toBe(true);
    await r.state.save();
    expect(r.saved().stopProcessing).toBe(true);
    expect(r.saved().actions.map((a) => a.type)).toEqual(['move']);
  });

  it('keeps the message in the inbox for a rule that only stopped', async () => {
    const r = open({ rule: existing({ actions: [{ type: 'stop' }] }) });
    expect(r.state.checklist.keep).toBe(true);
    expect(r.state.showsKeepRow).toBe(true);
    await r.state.save();
    expect(r.saved().actions).toEqual([{ type: 'keep' }]);
  });

  it('does not count the folded action as a change', () => {
    expect(open({ rule: existing({ actions: [{ type: 'stop' }] }) }).state.dirty).toBe(false);
  });

  it('counts an edit as a change', () => {
    const r = open({ rule: existing() });
    r.state.setName('Other');
    expect(r.state.dirty).toBe(true);
  });
});

describe('forwarding on a server with a limit', () => {
  it('locks Forward when the forwards before it already use the limit', () => {
    const r = open({ rule: existing(), maxRedirects: 1, forwardsBefore: 1 });
    expect(r.state.forwardLocked).toBe(true);
    r.state.actionControls.toggle('forward', true);
    expect(r.state.checklist.forward.on).toBe(false);
  });

  it('hides Forward where the server allows none, unless the rule forwards', () => {
    expect(open({ rule: existing(), maxRedirects: 0 }).state.showsForwardRow).toBe(false);
    const forwarding = open({ rule: existing({ actions: [{ type: 'forward', value: 'a@b.example' }] }), maxRedirects: 0 }).state;
    expect(forwarding.showsForwardRow).toBe(true);
    expect(forwarding.forwardUnavailable).toBe(true);
  });
});

describe('the "matches regex" comparator', () => {
  it('is offered only when the server lists the regex extension', () => {
    expect(open({ rule: existing() }).state.conditionRows[0].comparators).not.toContain('regex');
    expect(open({ rule: existing(), regexSupported: true }).state.conditionRows[0].comparators).toContain('regex');
  });

  it('is offered on header fields and the body, not on size or attachments', () => {
    const r = open({ rule: existing(), regexSupported: true });
    r.state.conditionActions.setKind(0, 'body');
    expect(r.state.conditionRows[0].comparators).toEqual(['contains', 'not_contains', 'regex']);
    r.state.conditionActions.setKind(0, 'size');
    expect(r.state.conditionRows[0].comparators).not.toContain('regex');
  });

  it('keeps commas inside the expression instead of splitting it into values', async () => {
    const r = open({ rule: existing({ conditions: [{ field: 'subject', comparator: 'contains', value: '' }] }), regexSupported: true });
    r.state.conditionActions.setComparator(0, 'regex');
    r.state.conditionActions.setText(0, '^Cron, job{1,3}');
    r.state.conditionActions.commitText(0);
    expect(r.state.conditionRows[0].text).toBe('^Cron, job{1,3}');
    await r.state.save();
    expect(r.saved().conditions).toEqual([{ field: 'subject', comparator: 'regex', value: '^Cron, job{1,3}' }]);
  });

  it('does not save an expression the server would refuse', async () => {
    const r = open({ rule: existing({ conditions: [{ field: 'subject', comparator: 'regex', value: '(unclosed' }] }), regexSupported: true });
    await r.state.save();
    expect(r.onSave).not.toHaveBeenCalled();
    expect(r.state.errors.conditions).toBe('This regular expression is not valid');
    expect(r.state.conditionRows[0].invalid).toBe(true);
  });

  it('stays on a saved regex rule when the server does not list the extension', () => {
    const r = open({ initialRule: existing({ conditions: [{ field: 'subject', comparator: 'regex', value: '^Cron' }] }) });
    expect(r.state.conditionRows[0].comparators).toContain('regex');
  });
});

describe('the other condition kinds', () => {
  it('offers "Delivered to" with address, domain and contains, and saves it (#726)', async () => {
    const r = open({ rule: existing() });
    r.state.conditionActions.setKind(0, 'delivered_to');
    expect(r.state.conditionRows[0].comparators.map((c) => t(`settings.filters.comparators.${c}`))).toEqual(['is the address', 'has the domain', 'contains']);
    r.state.conditionActions.setComparator(0, 'address_is');
    r.state.conditionActions.setText(0, 'shop@example.com');
    await r.state.save();
    expect(r.saved().conditions).toEqual([{ field: 'delivered_to', comparator: 'address_is', value: 'shop@example.com' }]);
  });

  it('offers "contains" and "does not contain" for the message text', () => {
    const r = open({ rule: existing() });
    r.state.conditionActions.setKind(0, 'body');
    expect(r.state.conditionRows[0].comparators).toEqual(['contains', 'not_contains']);
  });

  it('keeps an older body comparison a rule already has', () => {
    const r = open({ rule: existing({ conditions: [{ field: 'body', comparator: 'starts_with', value: 'Dear' }] }) });
    expect(r.state.conditionRows[0].comparators).toEqual(['contains', 'not_contains', 'starts_with']);
  });

  it('offers "All messages" without a comparator or a value, and turns back into a regular condition', async () => {
    const r = open();
    r.state.conditionActions.setKind(0, 'all');
    expect(r.state.conditionRows[0].comparators).toEqual([]);
    expect(r.state.conditionRows[0].takesValue).toBe(false);
    r.state.actionControls.toggle('star', true);
    await r.state.save();
    expect(r.saved().conditions).toEqual([{ field: 'all', comparator: 'any', value: '' }]);
    r.state.conditionActions.setKind(0, 'subject');
    expect(r.state.conditionRows[0].condition).toEqual({ field: 'subject', comparator: 'contains', value: '' });
  });

  it('keeps "All messages" next to a blank row', async () => {
    const r = open({ initialRule: existing({ conditions: [{ field: 'all', comparator: 'any', value: '' }] }) });
    r.state.conditionActions.add();
    await r.state.save();
    expect(r.saved().conditions).toEqual([{ field: 'all', comparator: 'any', value: '' }]);
  });

  it('drops the header name of a custom header condition it replaces', async () => {
    const r = open({ initialRule: existing({ conditions: [{ field: 'header', comparator: 'contains', value: 'bar', headerName: 'X-Foo' }] }) });
    r.state.conditionActions.setKind(0, 'all');
    await r.state.save();
    expect(r.saved().conditions[0]).not.toHaveProperty('headerName');
  });

  it('never removes the last condition', () => {
    const r = open();
    expect(r.state.conditionRows[0].removable).toBe(false);
    r.state.conditionActions.remove(0);
    expect(r.state.conditionRows).toHaveLength(1);
  });
});

describe('the rule period', () => {
  it('is offered only where the server supports it, or the rule has one', () => {
    expect(open({ rule: existing() }).state.periodShown).toBe(false);
    expect(open({ rule: existing(), periodsSupported: true }).state.periodShown).toBe(true);
    expect(open({ rule: existing({ activeFrom: '2026-01-01T00:00:00.000Z' }) }).state.periodShown).toBe(true);
  });

  it('asks for a start or an end when it is on but empty', async () => {
    const r = open({ rule: existing(), periodsSupported: true });
    r.state.setPeriodOn(true);
    await r.state.save();
    expect(r.state.errors.period).toBe('Enter a start or end date for the period');
    expect(r.state.firstError).toBe('period');
  });

  it('refuses an end that is not after the start', async () => {
    const r = open({ rule: existing(), periodsSupported: true });
    r.state.setPeriodOn(true);
    r.state.setPeriodStart('2026-12-02 10:00');
    r.state.setPeriodEnd('2026-12-01 10:00');
    await r.state.save();
    expect(r.state.errors.period).toBe('End date must be after start date');
  });

  it('keeps a saved boundary exactly while it is left as shown', async () => {
    const r = open({ rule: existing({ activeFrom: '2026-01-01T00:00:30.000Z' }), periodsSupported: true });
    await r.state.save();
    expect(r.saved().activeFrom).toBe('2026-01-01T00:00:30.000Z');
  });

  it('drops the period when it is switched off', async () => {
    const r = open({ rule: existing({ activeFrom: '2026-01-01T00:00:00.000Z' }) });
    r.state.setPeriodOn(false);
    await r.state.save();
    expect(r.saved().activeFrom).toBeUndefined();
    expect(r.saved().activeUntil).toBeUndefined();
  });

  it('previews only mail received within the period', async () => {
    const previewMatches = previewOf({ total: 1 });
    open({ rule: existing({ activeFrom: '2026-01-01T00:00:00.000Z', activeUntil: '2026-02-01T00:00:00.000Z' }), previewMatches });
    await settle();
    expect(previewMatches.mock.calls[0][0]).toMatchObject({ activeFrom: '2026-01-01T00:00:00.000Z', activeUntil: '2026-02-01T00:00:00.000Z' });
  });
});

const before = (overrides: Partial<FilterRule>) => existing({ name: 'Old rule', conditions: [{ field: 'from', comparator: 'contains', value: 'shop.example' }], ...overrides });
const savedBefore: Record<string, FilterRule> = {
  'move, then mark read': before({ actions: [{ type: 'move', mailboxId: 'news', value: 'News' }, { type: 'mark_read' }] }),
  'forward, then move': before({ actions: [{ type: 'forward', value: 'a@b.example' }, { type: 'move', mailboxId: 'news', value: 'News' }] }),
  'move, then copy': before({ actions: [{ type: 'move', mailboxId: 'news', value: 'News' }, { type: 'copy', mailboxId: 'archive', value: 'Archive' }] }),
  'keep, then forward': before({ actions: [{ type: 'keep' }, { type: 'forward', value: 'a@b.example', keepCopy: true }] }),
  'tag, then star': before({ actions: [{ type: 'add_label', value: 'red' }, { type: 'star' }] }),
  'several values and a header': before({
    matchType: 'any',
    conditions: [
      { field: 'from', comparator: 'domain_is', value: ['a.example', 'b.example'] },
      { field: 'header', headerName: 'List-Id', comparator: 'contains', value: 'news' },
      { field: 'size', comparator: 'greater_than', value: '5M' },
    ],
    actions: [{ type: 'move', mailboxId: 'news', value: 'News' }],
    includeSpam: true,
  }),
  'a period': before({ activeFrom: '2026-01-01T00:00:00.000Z', activeUntil: '2026-02-01T00:00:00.000Z' }),
  'stopping': before({ stopProcessing: true, enabled: false }),
  'a body comparison and Delivered to': before({
    conditions: [
      { field: 'body', comparator: 'not_contains', value: 'unsubscribe' },
      { field: 'delivered_to', comparator: 'domain_is', value: 'example.org' },
    ],
  }),
};

describe('a rule saved on the web, opened and saved on the phone without edits', () => {
  for (const [label, rule] of Object.entries(savedBefore)) {
    it(`saves "${label}" back unchanged`, async () => {
      const r = open({ rule, mailboxes: folders, periodsSupported: true });
      expect(r.state.dirty).toBe(false);
      expect(await r.state.save()).toBe(true);
      expect(generateScript([r.saved()])).toBe(generateScript([rule]));
    });
  }
});
