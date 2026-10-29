// Entry point of the headless task react-native-android-widget starts for
// every widget event (added, periodic update, resize, removed, tap). It can
// run in a cold JS runtime with no UI, so it only touches the stored snapshot
// and the widgets' own JMAP code.

import type { WidgetTaskHandlerProps } from 'react-native-android-widget';
import { handleWidgetAction } from './actions';
import { refreshSnapshot } from './build';
import { removeLocal } from './local-state';
import { drawOne, invalidatePlacedCache, redrawAll } from './render';
import { loadSnapshot } from './snapshot';

/** A snapshot younger than this is drawn as it is; older ones trigger a fetch. */
const FRESH_MS = 5 * 60 * 1000;

export async function widgetTaskHandler(props: WidgetTaskHandlerProps): Promise<void> {
  const { widgetInfo, widgetAction, clickAction, clickActionData, renderWidget } = props;
  const name = widgetInfo.widgetName;

  switch (widgetAction) {
    case 'WIDGET_ADDED':
    case 'WIDGET_UPDATE':
    case 'WIDGET_RESIZED': {
      if (widgetAction === 'WIDGET_ADDED') invalidatePlacedCache();
      renderWidget(await drawOne(name, widgetInfo));
      if (widgetAction === 'WIDGET_RESIZED') return;
      const stored = await loadSnapshot();
      if (stored && Date.now() - stored.generatedAt < FRESH_MS) return;
      // Every placed widget gets its own periodic update; they share one
      // refresh (see refreshSnapshot) and the redraws that follow collapse.
      await refreshSnapshot();
      await redrawAll();
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
