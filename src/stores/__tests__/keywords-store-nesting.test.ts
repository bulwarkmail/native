import { describe, it, expect, vi, beforeEach } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';

vi.mock('../../api/jmap-client', () => ({ jmapClient: { username: null, serverUrl: null, connectedAccountId: null } }));
vi.mock('../../api/bulwark-metadata', () => ({ getBulwarkMetadata: vi.fn() }));

import { useKeywordsStore, DEFAULT_KEYWORDS } from '../keywords-store';

beforeEach(async () => {
  await AsyncStorage.clear();
  useKeywordsStore.setState({ keywords: DEFAULT_KEYWORDS, nested: false, hydrated: false });
});

describe('nested tags and visibility in the tag store', () => {
  it('keeps "Nested tags" across a restart', async () => {
    useKeywordsStore.getState().setNested(true);
    expect(useKeywordsStore.getState().nested).toBe(true);
    await Promise.resolve();
    useKeywordsStore.setState({ nested: false, hydrated: false });
    await useKeywordsStore.getState().hydrate();
    expect(useKeywordsStore.getState().nested).toBe(true);
  });

  it('starts with nesting off, as the webmail does', async () => {
    await useKeywordsStore.getState().hydrate();
    expect(useKeywordsStore.getState().nested).toBe(false);
  });

  it("stores a tag's sidebar visibility with the tag, in the webmail's shape", async () => {
    useKeywordsStore.getState().add({ id: 'work/clients', label: 'Clients', color: 'teal' });
    useKeywordsStore.getState().update('work/clients', { visibility: 'unread' });
    await Promise.resolve();
    const stored = JSON.parse((await AsyncStorage.getItem('webmail:keywords:v1')) ?? '[]');
    expect(stored).toContainEqual({ id: 'work/clients', label: 'Clients', color: 'teal', visibility: 'unread' });
  });
});
