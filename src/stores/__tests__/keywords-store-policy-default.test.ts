import { describe, it, expect, beforeEach, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';

// The admin's default tags (policy `defaults.emailKeywords`, webmail #1612):
// new users start with them instead of the seven colour tags, until they
// change their own tags.

vi.mock('../auth-store', async () => {
  const { create } = await import('zustand');
  return { useAuthStore: create(() => ({ activeAccountId: null as string | null, session: null as unknown })) };
});

import { DEFAULT_KEYWORDS, useKeywordsStore } from '../keywords-store';
import { usePolicyStore } from '../policy-store';
import { sanitizePolicy } from '../../lib/org-policy';
import { applyPolicyDefaultTags } from '../../lib/org-policy-effects';
import { policyKeywordList } from '../../lib/policy-keywords';

const ADMIN = [
  { id: 'project', label: 'Project', color: 'blue-light' },
  { id: 'urgent', label: 'Urgent', color: 'red' },
];

function givenEffective(raw: unknown) {
  usePolicyStore.setState({ effective: raw === null ? null : sanitizePolicy(raw) });
}

beforeEach(async () => {
  await AsyncStorage.clear();
  useKeywordsStore.getState().applyPolicyDefault(null);
  useKeywordsStore.setState({ keywords: DEFAULT_KEYWORDS, hydrated: false, chosen: false });
  givenEffective(null);
});

describe('admin default tags', () => {
  it('replace the built-in tags for a user without tags of their own', async () => {
    await useKeywordsStore.getState().hydrate();
    expect(useKeywordsStore.getState().keywords).toEqual(DEFAULT_KEYWORDS);
    givenEffective({ defaults: { emailKeywords: ADMIN } });
    applyPolicyDefaultTags();
    expect(useKeywordsStore.getState().keywords).toEqual([
      { id: 'project', label: 'Project', color: 'blue' },
      { id: 'urgent', label: 'Urgent', color: 'red' },
    ]);
    // Not stored: they keep following the policy.
    expect(await AsyncStorage.getItem('webmail:keywords:v1')).toBeNull();
    // The policy stops setting them: the built-in tags again.
    givenEffective({ defaults: {} });
    applyPolicyDefaultTags();
    expect(useKeywordsStore.getState().keywords).toEqual(DEFAULT_KEYWORDS);
  });

  it('apply when the policy is known before the stored tags are read', async () => {
    givenEffective({ defaults: { emailKeywords: [] } });
    applyPolicyDefaultTags();
    await useKeywordsStore.getState().hydrate();
    // An empty list is a choice: no tags.
    expect(useKeywordsStore.getState().keywords).toEqual([]);
  });

  it('leave the tags of a user who has their own alone', async () => {
    await AsyncStorage.setItem('webmail:keywords:v1', JSON.stringify([{ id: 'mine', label: 'Mine', color: 'green' }]));
    await useKeywordsStore.getState().hydrate();
    givenEffective({ defaults: { emailKeywords: ADMIN } });
    applyPolicyDefaultTags();
    expect(useKeywordsStore.getState().keywords.map((k) => k.id)).toEqual(['mine']);
  });

  it('stop following the policy once the user changes a tag, and follow it again after a reset', async () => {
    await useKeywordsStore.getState().hydrate();
    givenEffective({ defaults: { emailKeywords: ADMIN } });
    applyPolicyDefaultTags();
    useKeywordsStore.getState().update('urgent', { label: 'Now' });
    givenEffective({ defaults: { emailKeywords: [ADMIN[0]] } });
    applyPolicyDefaultTags();
    expect(useKeywordsStore.getState().keywords.map((k) => k.label)).toEqual(['Project', 'Now']);
    useKeywordsStore.getState().resetDefaults();
    expect(useKeywordsStore.getState().keywords.map((k) => k.id)).toEqual(['project']);
  });

  it('refuse a list that is not one', () => {
    expect(policyKeywordList([{ id: 'a', label: 'A', color: 'red' }, { id: 'A', label: 'B', color: 'red' }])).toBeNull();
    expect(policyKeywordList([{ id: 'a b', label: 'A', color: 'red' }])).toBeNull();
    expect(policyKeywordList([{ id: 'a', label: ' ', color: 'red' }])).toBeNull();
    expect(policyKeywordList('red')).toBeNull();
    expect(policyKeywordList([{ id: 'a', label: 'A', color: 'chartreuse' }])).toEqual([{ id: 'a', label: 'A', color: 'gray' }]);
  });
});
