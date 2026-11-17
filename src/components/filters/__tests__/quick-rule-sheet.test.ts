import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => (await import('../../email/structured-mail/__tests__/render-native')).reactNativeMock());
vi.mock('../../icons', () => ({ ArrowRight: 'ArrowRight', Ban: 'Ban', MailOpen: 'MailOpen', Plus: 'Plus', Tag: 'Tag' }));
vi.mock('../../email/ActionSheet', () => ({ ActionSheet: 'ActionSheet' }));
vi.mock('../../MoveSheet', () => ({ MoveSheet: 'MoveSheet' }));
vi.mock('../RuleEditorSheet', () => ({ RuleEditorSheet: 'RuleEditorSheet' }));
vi.mock('../../../api/jmap-client', () => ({
  jmapClient: {
    get accountId(): string { throw new Error('Not authenticated - call connect() first'); },
    connectedAccountId: null,
  },
}));
vi.mock('../../../api/sieve', () => ({ getSieveAccountId: () => null, getSieveCapabilities: () => null }));
vi.mock('../../../api/sieve-rules', () => ({
  FiltersLoginChangedError: class extends Error {},
  OpaqueFiltersError: class extends Error {},
  readAccountFilters: vi.fn(),
  updateAccountFilters: vi.fn(),
}));
vi.mock('../../../lib/sieve/retroactive-run', () => ({ executeRetroPlan: vi.fn() }));

import { findAll, render, renderHook, type HostNode } from '../../email/structured-mail/__tests__/render-native';
import { QuickRuleSheet } from '../QuickRuleSheet';
import { useKeywordsStore } from '../../../stores/keywords-store';
import { useColors } from '../../../theme/colors';
import type { Email } from '../../../api/types';

const email = { id: 'm1', from: [{ name: 'News', email: 'news@acme.example' }], keywords: {}, mailboxIds: { inbox: true } } as unknown as Email;

describe('Create rule, from a message', () => {
  it('opens before the session is up again after a cold start', () => {
    expect(() => render(createElement(QuickRuleSheet, { visible: true, email, mailboxes: [], onClose: vi.fn() }))).not.toThrow();
  });

  it('lists each tag with its own colour', () => {
    useKeywordsStore.setState({
      keywords: [
        { id: 'work', label: 'Work', color: 'blue' },
        { id: 'odd', label: 'Odd', color: 'nope' as never },
      ],
    });
    const c = renderHook(() => useColors()).current;
    const tree = render(createElement(QuickRuleSheet, { visible: true, email, mailboxes: [], onClose: vi.fn() }));
    const sheets = findAll(tree, (n: HostNode) => n.type === 'ActionSheet');
    const tagSheet = sheets.find((s) => (s.props.items as Array<{ key: string }>).some((i) => i.key === 'work'))!;
    const icon = (key: string) => (tagSheet.props.items as Array<{ key: string; icon: { props: { color: string; fill: string } } }>).find((i) => i.key === key)!.icon.props;
    expect(icon('work')).toMatchObject({ color: c.tags.blue.dot, fill: c.tags.blue.dot });
    expect(icon('odd')).toMatchObject({ color: c.tags.gray.dot, fill: c.tags.gray.dot });
  });
});
