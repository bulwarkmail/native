// The iOS inbox widget (WidgetKit, plugins/ios-widget). It can't run JS, so
// the app hands it a small finished snapshot: the active account's inbox
// unread count and newest messages, cut from the data the Android widgets
// draw (./snapshot.ts), with the texts already translated and each message's
// deep link (./clicks.ts) ready to open.
//
// The snapshot sits in the keychain group the app already shares with its
// extensions (src/lib/ios-push-shared.ts): an app group would need a new
// capability on every provisioning profile, the keychain group needs none.
// After each write the app asks WidgetKit to redraw (BulwarkWidgetKit).

import { NativeModules, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { sharedStoreOptions } from '../lib/ios-push-shared';
import { links } from './clicks';
import { makeFmt } from './format';
import { normalizeHex } from './theme';
import type { WidgetSnapshot } from './snapshot';

/** Read by plugins/ios-widget/BulwarkWidget.swift. */
export const IOS_WIDGET_KEY = 'bulwark_widget_inbox';

/** Messages a large widget can show; smaller ones take the first few. */
const MAX_MESSAGES = 6;

export interface IosWidgetMessage {
  id: string;
  from: string;
  initials: string;
  color: string;
  subject: string;
  preview: string;
  receivedAt: number;
  unread: boolean;
  /** Opens the message in the app. */
  url: string;
}

export interface IosWidgetSnapshot {
  version: 1;
  generatedAt: number;
  signedIn: boolean;
  theme: 'light' | 'dark' | 'system';
  locale: string;
  hour12: boolean;
  /** The active account's label; null with a single account. */
  account: string | null;
  unread: number;
  inboxUrl: string;
  composeUrl: string;
  messages: IosWidgetMessage[];
  strings: { inbox: string; unread: string; empty: string; signedOut: string; noSubject: string };
}

export function iosWidgetSnapshot(s: WidgetSnapshot): IosWidgetSnapshot {
  const f = makeFmt(s.locale, s.hour12);
  const noSubject = f.t('widgets.mail.no_subject', '(no subject)');
  const inbox = s.mail.folders.find((folder) => folder.role === 'inbox');
  const account = s.accounts.length > 1 ? s.accounts.find((a) => a.id === s.activeAccountId)?.label ?? null : null;
  return {
    version: 1,
    generatedAt: s.generatedAt,
    signedIn: s.signedIn,
    theme: s.theme,
    locale: s.locale,
    hour12: s.hour12,
    account,
    unread: inbox?.unread ?? 0,
    inboxUrl: links.inbox(),
    composeUrl: links.compose(),
    messages: s.mail.inbox.slice(0, MAX_MESSAGES).map((m) => ({
      id: m.id,
      from: m.fromName || m.fromEmail,
      initials: m.initials,
      color: normalizeHex(m.color),
      subject: m.subject || noSubject,
      preview: m.preview,
      receivedAt: m.receivedAt,
      unread: m.unread,
      url: links.message(m),
    })),
    strings: {
      inbox: f.t('widgets.mail.inbox', 'Inbox'),
      unread: f.t('widgets.mail.unread', 'unread'),
      empty: f.t('widgets.mail.empty_inbox', 'Your inbox is empty'),
      signedOut: f.t('widgets.state.signed_out', 'Sign in to Bulwark'),
      noSubject,
    },
  };
}

type WidgetKitModule = { reloadAll?: () => Promise<void>; placedCount?: () => Promise<number> };

function widgetKit(): WidgetKitModule | undefined {
  return NativeModules.BulwarkWidgetKit as WidgetKitModule | undefined;
}

/** Whether an inbox widget is on the home screen (or the module can't tell). */
export async function iosWidgetPlaced(): Promise<boolean> {
  const count = widgetKit()?.placedCount;
  if (!count) return false;
  try {
    return (await count()) > 0;
  } catch {
    return true;
  }
}

/** Hand the widget what it shows and have WidgetKit redraw it. */
export async function writeIosWidget(s: WidgetSnapshot): Promise<void> {
  if (Platform.OS !== 'ios') return;
  const options = sharedStoreOptions();
  if (!options) return;
  await SecureStore.setItemAsync(IOS_WIDGET_KEY, JSON.stringify(iosWidgetSnapshot(s)), options);
  await widgetKit()?.reloadAll?.().catch(() => undefined);
}
