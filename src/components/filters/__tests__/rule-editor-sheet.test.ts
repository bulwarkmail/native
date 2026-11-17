import { createElement } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => ({
  ...(await import('../../email/structured-mail/__tests__/render-native')).reactNativeMock(),
  KeyboardAvoidingView: 'KeyboardAvoidingView',
  TextInput: 'TextInput',
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
}));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  SafeAreaProvider: 'SafeAreaProvider',
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@react-native-community/datetimepicker', () => ({ default: 'DateTimePicker', DateTimePickerAndroid: { open: vi.fn() } }));
vi.mock('../../icons', () => Object.fromEntries(['Check', 'CheckSquare', 'ChevronDown', 'Plus', 'Square', 'X'].map((name) => [name, name])));
vi.mock('../../email/ActionSheet', () => ({ ActionSheet: 'ActionSheet' }));
vi.mock('../../MoveSheet', () => ({ MoveSheet: 'MoveSheet' }));
vi.mock('../../../lib/sheet-bottom-inset', () => ({ useModalKeyboardPadding: () => 0 }));
vi.mock('../../../lib/sieve/retroactive-run', () => ({ executeRetroPlan: vi.fn() }));
vi.mock('../../../api/jmap-client', () => ({ jmapClient: { accountId: 'own' } }));
vi.mock('../use-rule-editor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../use-rule-editor')>();
  return {
    ...actual,
    useRuleEditor: (options: Parameters<typeof actual.useRuleEditor>[0]) => ({
      ...actual.useRuleEditor(options),
      applyOptions: [
        { value: 'new', label: 'New mail only', disabled: false },
        { value: 'all', label: 'New mail and all mail (7)', disabled: false },
      ],
      effectiveApply: 'new',
    }),
  };
});

import { byLabel, byTestId, findAll, render, renderHook, textOf, type HostNode } from '../../email/structured-mail/__tests__/render-native';
import { RuleEditorSheet } from '../RuleEditorSheet';
import { useKeywordsStore } from '../../../stores/keywords-store';
import { useColors } from '../../../theme/colors';
import type { FilterRule } from '../../../lib/sieve/types';

const rule: FilterRule = {
  id: 'r1',
  name: 'Statements',
  enabled: true,
  matchType: 'all',
  conditions: [
    { field: 'from', comparator: 'contains', value: 'bank.example' },
    { field: 'attachment', comparator: 'has_any', value: '' },
  ],
  actions: [{ type: 'mark_read' }],
  stopProcessing: false,
};

function sheet(): HostNode {
  return render(createElement(RuleEditorSheet, { visible: true, rule, mailboxes: [], onSave: vi.fn(), onClose: vi.fn() }));
}

describe('the rule editor on a phone', () => {
  it('reads as a sentence: If all of these conditions apply', () => {
    const tree = sheet();
    const texts = findAll(tree, (n) => n.type === 'Text').map(textOf);
    const at = texts.indexOf('If');
    expect(texts.slice(at, at + 3)).toEqual(['If', 'all', 'of these conditions apply']);
    expect(byTestId(tree, 'rule-match-type')[0].props.accessibilityLabel).toBe('Which conditions must apply: all');
  });

  it('numbers the conditions and names each picker for a screen reader', () => {
    const tree = sheet();
    expect(byTestId(tree, 'rule-condition-1')).toHaveLength(1);
    expect(byTestId(tree, 'rule-condition-2')).toHaveLength(1);
    expect(byLabel(tree, 'Condition 1: From')).toHaveLength(1);
    expect(byLabel(tree, 'Condition 2: Has an attachment')).toHaveLength(1);
    expect(byLabel(tree, /^Comparison:/)).toHaveLength(1);
  });

  it('shows the Then actions as checkboxes, with Continue and Skip', () => {
    const tree = sheet();
    const boxes = findAll(tree, (n) => n.props.accessibilityRole === 'checkbox');
    const labels = boxes.map((b) => b.props.accessibilityLabel);
    expect(labels).toEqual(expect.arrayContaining([
      'Mark as read', 'Star message', 'Move to folder', 'Copy to folder', 'Forward to', 'Reject with message',
      'Discard (delete silently)', 'Continue to apply other rules', 'Skip this rule',
    ]));
    expect(boxes.find((b) => b.props.accessibilityLabel === 'Mark as read')!.props.accessibilityState.checked).toBe(true);
    expect(boxes.find((b) => b.props.accessibilityLabel === 'Continue to apply other rules')!.props.accessibilityState.checked).toBe(true);
  });

  it('shows each tag in its own colour, and a chosen tag filled with it', () => {
    useKeywordsStore.setState({
      keywords: [
        { id: 'work', label: 'Work', color: 'blue' },
        { id: 'family', label: 'Family', color: 'green' },
        { id: 'odd', label: 'Odd', color: 'nope' as never },
      ],
    });
    const c = renderHook(() => useColors()).current;
    const tree = render(createElement(RuleEditorSheet, {
      visible: true,
      rule: { ...rule, actions: [{ type: 'add_label', value: 'work' }, { type: 'add_label', value: 'gone' }] },
      mailboxes: [],
      onSave: vi.fn(),
      onClose: vi.fn(),
    }));
    const chip = (id: string) => byTestId(tree, `rule-tag-${id}`)[0];
    const dot = (id: string) => byTestId(chip(id), `rule-tag-${id}-dot`)[0].props.style;
    const flat = (style: unknown) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));

    expect(chip('work').props.accessibilityState.checked).toBe(true);
    expect(flat(dot('work')).backgroundColor).toBe(c.tags.blue.dot);
    expect(flat(chip('work').props.style)).toMatchObject({ backgroundColor: c.tags.blue.bg, borderColor: c.tags.blue.dot });
    expect(flat(findAll(chip('work'), (n) => n.type === 'Text')[0].props.style).color).toBe(c.tags.blue.text);

    expect(chip('family').props.accessibilityState.checked).toBe(false);
    expect(flat(dot('family')).backgroundColor).toBe(c.tags.green.dot);
    expect(flat(chip('family').props.style).backgroundColor).not.toBe(c.tags.green.bg);

    expect(flat(dot('odd')).backgroundColor).toBe(c.tags.gray.dot);
    expect(flat(dot('gone')).backgroundColor).toBe(c.tags.gray.dot);
    expect(chip('gone').props.accessibilityState.checked).toBe(true);
  });

  it('suggests the name it will save under in the empty name field', () => {
    const tree = render(createElement(RuleEditorSheet, { visible: true, initialRule: { ...rule, name: '' }, mailboxes: [], onSave: vi.fn(), onClose: vi.fn() }));
    const name = byLabel(tree, 'Rule name')[0];
    expect(name.props.placeholder).toBe('From bank.example +1 → Mark as read');
  });

  it('keeps Apply to next to Save, out of the scrolling body', () => {
    const tree = sheet();
    const scroll = findAll(tree, (n) => n.type === 'ScrollView')[0];
    const apply = byTestId(tree, 'rule-apply-to')[0];
    expect(apply.props.accessibilityLabel).toBe('Apply to: New mail only');
    expect(findAll(scroll, (n) => n === apply)).toHaveLength(0);
    const save = findAll(tree, (n) => n.type === 'Text' && textOf(n) === 'Save');
    expect(save.length).toBeGreaterThan(0);
    expect(findAll(scroll, (n) => n === save[0])).toHaveLength(0);
  });

  it('makes room for the keyboard', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'RuleEditorSheet.tsx'), 'utf8');
    expect(source).toMatch(/const keyboardPadding = useModalKeyboardPadding\(true\);/);
    expect(source).toMatch(/paddingBottom: keyboardPadding/);
  });
});
