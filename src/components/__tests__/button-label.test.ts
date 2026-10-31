import { describe, expect, it, vi } from 'vitest';

// React Native resets a view's content description only when the new one is
// non-empty. A Button that showed its spinner (TalkBack reads "busy") and
// then its text again kept "busy" as its name when it passed no label, so
// TalkBack read Save as "busy". A text button names itself by its text.

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  Text: 'Text',
  ActivityIndicator: 'ActivityIndicator',
  StyleSheet: { create: <T,>(s: T) => s },
}));
vi.mock('../../theme/colors', () => ({ useColors: () => ({}) }));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  const useMemo = <T,>(fn: () => T) => fn();
  return { ...actual, useMemo, default: { ...actual, useMemo } };
});

import Button from '../Button';

type Rendered = { props: { accessibilityLabel?: string; accessibilityState?: { busy?: boolean } } };
const render = (props: Parameters<typeof Button>[0]) => Button(props) as unknown as Rendered;

describe('Button accessibility name', () => {
  it('names a text button by its text, while loading and after', () => {
    expect(render({ children: 'Save', loading: true }).props.accessibilityLabel).toBe('Save');
    expect(render({ children: 'Save', loading: false }).props.accessibilityLabel).toBe('Save');
    expect(render({ children: 'Save', loading: true }).props.accessibilityState?.busy).toBe(true);
  });

  it('keeps an explicit label', () => {
    expect(render({ children: 'Save', accessibilityLabel: 'Save draft' }).props.accessibilityLabel).toBe('Save draft');
  });

  it('leaves a button with element children to its label prop', () => {
    expect(render({ children: null, accessibilityLabel: 'Close' }).props.accessibilityLabel).toBe('Close');
    expect(render({ children: null }).props.accessibilityLabel).toBeUndefined();
  });
});
