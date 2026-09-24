import { useCallback } from 'react';
import { BackHandler } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

/**
 * While `active` and the screen is focused, Android's hardware back runs
 * `onBack` instead of navigating (e.g. to leave a selection mode first).
 * Tab screens stay mounted while another tab is shown, so the listener is
 * tied to focus: a plain BackHandler listener would also swallow the back
 * presses meant for the other tabs.
 */
export function useBackWhileFocused(active: boolean, onBack: () => void): void {
  useFocusEffect(
    useCallback(() => {
      if (!active) return undefined;
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        onBack();
        return true;
      });
      return () => subscription.remove();
    }, [active, onBack]),
  );
}
