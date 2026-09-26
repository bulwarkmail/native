// Entry point of the headless task react-native-android-widget starts for
// every widget event (added, periodic update, resize, removed, tap). It can
// run in a cold JS runtime with no UI, so it only touches the stored snapshot
// and the widgets' own JMAP code.

import type { WidgetTaskHandlerProps } from 'react-native-android-widget';
import { handleWidgetAction } from './actions';
import { refreshSnapshot } from './build';
import { loadLocal, removeLocal } from './local-state';
import { invalidatePlacedCache, renderFor, updateAllWidgets } from './render';
import { emptySnapshot, loadSnapshot, type WidgetSnapshot } from './snapshot';

/** A snapshot younger than this is drawn as it is; older ones trigger a fetch. */
const FRESH_MS = 5 * 60 * 1000;

let lastBroadcast = 0;

async function broadcast(snapshot: WidgetSnapshot): Promise<void> {
  // Every placed widget gets its own periodic update; the first one to finish
  // a refresh redraws them all, the others would only repeat it.
  if (snapshot.generatedAt <= lastBroadcast) return;
  lastBroadcast = snapshot.generatedAt;
  await updateAllWidgets(snapshot);
}

export async function widgetTaskHandler(props: WidgetTaskHandlerProps): Promise<void> {
  const { widgetInfo, widgetAction, clickAction, clickActionData, renderWidget } = props;
  const name = widgetInfo.widgetName;

  switch (widgetAction) {
    case 'WIDGET_ADDED':
    case 'WIDGET_UPDATE':
    case 'WIDGET_RESIZED': {
      if (widgetAction === 'WIDGET_ADDED') invalidatePlacedCache();
      const snapshot = (await loadSnapshot()) ?? emptySnapshot();
      renderWidget(renderFor(name, snapshot, widgetInfo, await loadLocal(widgetInfo.widgetId)));
      if (widgetAction === 'WIDGET_RESIZED') return;
      if (Date.now() - snapshot.generatedAt < FRESH_MS) return;
      const fresh = await refreshSnapshot();
      renderWidget(renderFor(name, fresh, widgetInfo, await loadLocal(widgetInfo.widgetId)));
      await broadcast(fresh);
      return;
    }

    case 'WIDGET_DELETED':
      invalidatePlacedCache();
      await removeLocal(widgetInfo.widgetId);
      return;

    case 'WIDGET_CLICK':
      if (clickAction) await handleWidgetAction(clickAction, clickActionData ?? {}, widgetInfo.widgetId);
      return;

    default:
      return;
  }
}
