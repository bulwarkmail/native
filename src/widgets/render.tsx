// Turns the snapshot into widget trees and pushes them to the launcher.

import React from 'react';
import { Platform } from 'react-native';
import {
  getWidgetInfo,
  requestWidgetUpdate,
  type WidgetInfo,
  type WidgetRepresentation,
} from 'react-native-android-widget';
import catalog from './catalog.json';
import { makeFmt } from './format';
import { loadLocal } from './local-state';
import { Placeholder, Surface } from './primitives';
import type { WidgetSnapshot } from './snapshot';
import { DARK, LIGHT, type WidgetPalette } from './theme';
import type { Layout, WidgetLocalState } from './layouts/types';
import * as mail from './layouts/mail';
import * as moreMail from './layouts/more-mail';
import * as calendar from './layouts/calendar';
import * as plans from './layouts/plans';
import * as hubs from './layouts/hubs';

export const WIDGET_NAMES: string[] = catalog.widgets.map((w) => w.name);

const LAYOUTS: Record<string, Layout> = {
  InboxWidget: mail.InboxLayout,
  TriageWidget: mail.TriageLayout,
  UnreadCountWidget: mail.UnreadCountLayout,
  LatestMessageWidget: mail.LatestMessageLayout,
  FolderCountsWidget: mail.FolderCountsLayout,
  MailShortcutsWidget: mail.MailShortcutsLayout,
  AllAccountsWidget: moreMail.AllAccountsLayout,
  StarredWidget: moreMail.StarredLayout,
  FavouritePeopleWidget: moreMail.FavouritePeopleLayout,
  MailSearchWidget: moreMail.MailSearchLayout,
  OutboxWidget: moreMail.OutboxLayout,
  TagWidget: moreMail.TagLayout,
  LastDraftWidget: moreMail.LastDraftLayout,
  AgendaWidget: calendar.AgendaLayout,
  WeekWidget: calendar.WeekLayout,
  MonthWidget: calendar.MonthLayout,
  TodayEventsWidget: calendar.TodayEventsLayout,
  NextEventWidget: calendar.NextEventLayout,
  DateNextWidget: calendar.DateNextLayout,
  UpNextWidget: calendar.UpNextLayout,
  InvitationsWidget: plans.InvitationsLayout,
  FreeTimeWidget: plans.FreeTimeLayout,
  TasksWidget: plans.TasksLayout,
  TaskProgressWidget: plans.TaskProgressLayout,
  CountdownWidget: plans.CountdownLayout,
  BirthdaysWidget: plans.BirthdaysLayout,
  TodayHubWidget: hubs.TodayHubLayout,
  MailAndNextWidget: hubs.MailAndNextLayout,
  RecentFilesWidget: hubs.RecentFilesLayout,
  AttachmentsWidget: hubs.AttachmentsLayout,
  VacationWidget: hubs.VacationLayout,
  StorageWidget: hubs.StorageLayout,
};

const STATIC = new Set(catalog.widgets.filter((w) => 'static' in w && w.static).map((w) => w.name));

// Widgets whose data only the running app can load (calendar, tasks, files,
// scheduled sends): until it has, they ask for the app to be opened instead
// of claiming there is nothing to show.
const NEEDS_APP = new Set([
  ...catalog.widgets.filter((w) => w.board === 'calendar' || w.board === 'plans').map((w) => w.name),
  'OutboxWidget',
  'TodayHubWidget',
  'RecentFilesWidget',
]);

function draw(
  name: string,
  s: WidgetSnapshot,
  p: WidgetPalette,
  info: Pick<WidgetInfo, 'width' | 'height' | 'widgetId'>,
  local: WidgetLocalState,
  now: number,
): React.JSX.Element {
  const f = makeFmt(s.locale, s.hour12);
  const openApp = { clickAction: 'OPEN_APP' };
  const layout = LAYOUTS[name];
  if (!layout) {
    return <Surface p={p}><Placeholder p={p} iconName="mail" title="Bulwark" click={openApp} /></Surface>;
  }
  if (!STATIC.has(name)) {
    if (!s.signedIn && s.generatedAt > 0) {
      return (
        <Surface p={p}>
          <Placeholder p={p} iconName="lock" title={f.t('widgets.state.signed_out', 'Sign in to Bulwark')} click={openApp} />
        </Surface>
      );
    }
    if (s.generatedAt === 0) {
      return (
        <Surface p={p}>
          <Placeholder
            p={p}
            iconName="refresh"
            title={f.t('widgets.state.loading', 'Loading…')}
            body={f.t('widgets.state.open_app', 'Open the app once if this stays empty.')}
            click={openApp}
          />
        </Surface>
      );
    }
    if (NEEDS_APP.has(name) && !s.appDataAt) {
      return (
        <Surface p={p}>
          <Placeholder p={p} iconName="refresh" title={f.t('widgets.state.open_to_load', 'Open Bulwark to load this')} click={openApp} />
        </Surface>
      );
    }
  }
  try {
    return layout({ s, p, f, now, width: info.width, height: info.height, widgetId: info.widgetId, local });
  } catch (err) {
    console.warn(`[widgets] ${name} failed to draw`, err);
    return (
      <Surface p={p}>
        <Placeholder p={p} iconName="ban" title={f.t('widgets.state.error', "Couldn't show this widget")} click={openApp} />
      </Surface>
    );
  }
}

/**
 * Light and dark trees when the app follows the system, one tree otherwise.
 * `now` is only fixed for the picker previews.
 */
export function renderFor(
  name: string,
  s: WidgetSnapshot,
  info: Pick<WidgetInfo, 'width' | 'height' | 'widgetId'>,
  local: WidgetLocalState,
  now = Date.now(),
): WidgetRepresentation {
  if (s.theme === 'light') return draw(name, s, LIGHT, info, local, now);
  if (s.theme === 'dark') return draw(name, s, DARK, info, local, now);
  return { light: draw(name, s, LIGHT, info, local, now), dark: draw(name, s, DARK, info, local, now) };
}

/** Redraw every placed widget of every kind from `snapshot`. */
export async function updateAllWidgets(snapshot: WidgetSnapshot): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Promise.all(WIDGET_NAMES.map((widgetName) =>
    requestWidgetUpdate({
      widgetName,
      renderWidget: async (info) => renderFor(widgetName, snapshot, info, await loadLocal(info.widgetId)),
    }).catch((err) => console.warn(`[widgets] update of ${widgetName} failed`, err)),
  ));
}

let placedCache: { at: number; value: boolean } | null = null;

/** Whether any Bulwark widget is on a home screen; cached briefly. */
export async function hasPlacedWidgets(maxAgeMs = 60_000): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  if (placedCache && Date.now() - placedCache.at < maxAgeMs) return placedCache.value;
  const counts = await Promise.all(WIDGET_NAMES.map((n) => getWidgetInfo(n).then((l) => l.length).catch(() => 0)));
  const value = counts.some((c) => c > 0);
  placedCache = { at: Date.now(), value };
  return value;
}

export function invalidatePlacedCache(): void {
  placedCache = null;
}
