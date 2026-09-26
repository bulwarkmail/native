import type React from 'react';
import type { Fmt } from '../format';
import type { WidgetSnapshot } from '../snapshot';
import type { WidgetPalette } from '../theme';

/** Per-widget state kept between draws (e.g. which message the triage card shows). */
export type WidgetLocalState = Record<string, unknown>;

export interface LayoutProps {
  s: WidgetSnapshot;
  p: WidgetPalette;
  f: Fmt;
  now: number;
  /** Widget size in dp as the launcher reports it. */
  width: number;
  height: number;
  widgetId: number;
  local: WidgetLocalState;
}

export type Layout = (props: LayoutProps) => React.JSX.Element;
