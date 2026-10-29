// State that belongs to one placed widget rather than to the data: which
// message the triage card is showing. Keyed by the launcher's widget id and
// dropped when the widget is removed.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { WidgetLocalState } from './layouts/types';

const key = (widgetId: number) => `widgets:local:${widgetId}`;

export async function loadLocal(widgetId: number): Promise<WidgetLocalState> {
  try {
    const raw = await AsyncStorage.getItem(key(widgetId));
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as WidgetLocalState) : {};
  } catch {
    return {};
  }
}

export async function saveLocal(widgetId: number, state: WidgetLocalState): Promise<void> {
  await AsyncStorage.setItem(key(widgetId), JSON.stringify(state));
}

export async function removeLocal(widgetId: number): Promise<void> {
  await AsyncStorage.removeItem(key(widgetId));
}
