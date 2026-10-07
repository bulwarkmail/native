import { beforeEach, describe, expect, it } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useGlobalSearchStore } from '../store';

describe('global-search-store', () => {
  beforeEach(() => {
    useGlobalSearchStore.setState({ isOpen: false, query: '', scope: 'all', accountId: null });
  });

  it('opens with an optional initial query and closes without losing it', () => {
    const s = useGlobalSearchStore.getState();
    s.openPalette('report');
    expect(useGlobalSearchStore.getState()).toMatchObject({ isOpen: true, query: 'report' });
    useGlobalSearchStore.getState().closePalette();
    expect(useGlobalSearchStore.getState()).toMatchObject({ isOpen: false, query: 'report' });
    // Re-opening without an initial query keeps the previous one.
    useGlobalSearchStore.getState().openPalette();
    expect(useGlobalSearchStore.getState().query).toBe('report');
  });

  it('toggles', () => {
    useGlobalSearchStore.getState().togglePalette();
    expect(useGlobalSearchStore.getState().isOpen).toBe(true);
    useGlobalSearchStore.getState().togglePalette();
    expect(useGlobalSearchStore.getState().isOpen).toBe(false);
  });

  it('rejects unknown scopes', () => {
    useGlobalSearchStore.getState().setScope('mail');
    expect(useGlobalSearchStore.getState().scope).toBe('mail');
    useGlobalSearchStore.getState().setScope('bogus' as never);
    expect(useGlobalSearchStore.getState().scope).toBe('all');
  });

  it('persists only the scope', async () => {
    useGlobalSearchStore.setState({ isOpen: true, query: 'secret', scope: 'files', accountId: 'a' });
    await Promise.resolve();
    const raw = await AsyncStorage.getItem('global-search');
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw as string);
    expect(persisted.state).toEqual({ scope: 'files' });
  });
});
