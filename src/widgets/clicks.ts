// What a tap on part of a widget does. Either it opens the app on a deep link
// (handled by src/navigation/linking.ts, no JS needed in the widget), or it
// names an action the widget task performs in the background (./actions.ts).

import { APP_SCHEME } from '../navigation/linking';
import type { EventItem, MailItem } from './snapshot';

export interface WidgetClick {
  clickAction?: string;
  clickActionData?: Record<string, unknown>;
}

export type WidgetActionName =
  | 'archive'
  | 'trash'
  | 'markRead'
  | 'triageNext'
  | 'rsvp'
  | 'toggleTask'
  | 'refresh';

export function action(name: WidgetActionName, data: Record<string, unknown> = {}): WidgetClick {
  return { clickAction: name, clickActionData: data };
}

export function open(uri: string): WidgetClick {
  return { clickAction: 'OPEN_URI', clickActionData: { uri } };
}

const base = `${APP_SCHEME}://`;
const enc = encodeURIComponent;

function query(params: Record<string, string | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${enc(v!)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export const links = {
  inbox: () => `${base}mail/folder/inbox`,
  message: (m: Pick<MailItem, 'id' | 'accountId' | 'jmapAccountId'>) =>
    `${base}mail/message/${enc(m.id)}${query({ account: m.accountId, jmapAccount: m.jmapAccountId })}`,
  reply: (m: Pick<MailItem, 'id' | 'accountId' | 'jmapAccountId'>) =>
    `${base}mail/message/${enc(m.id)}${query({ account: m.accountId, jmapAccount: m.jmapAccountId, action: 'reply' })}`,
  draft: (m: Pick<MailItem, 'id' | 'accountId' | 'jmapAccountId'>) =>
    `${base}mail/draft/${enc(m.id)}${query({ account: m.accountId, jmapAccount: m.jmapAccountId })}`,
  unified: (params: { view?: 'all' | 'unread' | 'starred'; role?: string } = {}) =>
    `${base}mail/unified${query({ view: params.view, role: params.role })}`,
  scheduled: () => `${base}mail/scheduled`,
  search: (q = '') => `${base}mail/search${query({ q })}`,
  compose: (params: { to?: string; subject?: string; body?: string } = {}) =>
    `${base}compose${query({ to: params.to, subject: params.subject, body: params.body })}`,
  calendar: () => `${base}calendar`,
  event: (e: Pick<EventItem, 'serverId' | 'jmapAccountId'>) =>
    `${base}calendar/event/${enc(e.serverId)}${query({ account: e.jmapAccountId })}`,
  contacts: () => `${base}contacts`,
  files: () => `${base}files`,
  settings: (tab?: string) => `${base}settings${tab ? `/${enc(tab)}` : ''}`,
};
