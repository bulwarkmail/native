// What a tap on part of a widget does. Either it opens the app on a deep link
// (handled by src/navigation/linking.ts, no JS needed in the widget), or it
// names an action the widget task performs in the background (./actions.ts).

import { APP_SCHEME } from '../navigation/linking';
import type { EventItem, Invitation, MailItem, TaskItem } from './snapshot';

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

/**
 * A task tick. It names the state the user asked for, not "the opposite of
 * now": a second tap on a drawing that has not caught up yet would otherwise
 * undo the first. It carries the task's account and server id so it acts on
 * that task even when the widgets have moved on to another account.
 */
export function toggleTask(task: TaskItem): WidgetClick {
  return action('toggleTask', {
    id: task.id,
    done: !task.done,
    serverId: task.serverId,
    title: task.title,
    ...(task.accountId ? { accountId: task.accountId } : {}),
    ...(task.jmapAccountId ? { jmapAccountId: task.jmapAccountId } : {}),
  });
}

/** An RSVP; like {@link toggleTask} it carries everything the call needs. */
export function rsvp(inv: Invitation, status: 'accepted' | 'tentative' | 'declined'): WidgetClick {
  return action('rsvp', {
    id: inv.id,
    status,
    serverId: inv.serverId,
    participantId: inv.participantId,
    title: inv.title,
    ...(inv.accountId ? { accountId: inv.accountId } : {}),
    ...(inv.jmapAccountId ? { jmapAccountId: inv.jmapAccountId } : {}),
  });
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

// Message links carry the thread so the app opens them without asking the
// server first, which also works offline from its cache.
type MessageRef = Pick<MailItem, 'id' | 'accountId' | 'jmapAccountId'> & { threadId?: string };

export const links = {
  inbox: () => `${base}mail/folder/inbox`,
  message: (m: MessageRef) =>
    `${base}mail/message/${enc(m.id)}${query({ account: m.accountId, jmapAccount: m.jmapAccountId, thread: m.threadId })}`,
  reply: (m: MessageRef) =>
    `${base}mail/message/${enc(m.id)}${query({ account: m.accountId, jmapAccount: m.jmapAccountId, thread: m.threadId, action: 'reply' })}`,
  draft: (m: Pick<MailItem, 'id' | 'accountId' | 'jmapAccountId'>) =>
    `${base}mail/draft/${enc(m.id)}${query({ account: m.accountId, jmapAccount: m.jmapAccountId })}`,
  unified: (params: { view?: 'all' | 'unread' | 'starred'; role?: string } = {}) =>
    `${base}mail/unified${query({ view: params.view, role: params.role })}`,
  scheduled: () => `${base}mail/scheduled`,
  search: (q = '') => `${base}mail/search${query({ q })}`,
  compose: (params: { to?: string; subject?: string; body?: string } = {}) =>
    `${base}compose${query({ to: params.to, subject: params.subject, body: params.body })}`,
  calendar: () => `${base}calendar`,
  // `account` is the JMAP account of a shared calendar (as in webmail
  // permalinks); `appAccount` the signed-in account the event was shown for.
  event: (e: Pick<EventItem, 'serverId' | 'jmapAccountId' | 'accountId'>) =>
    `${base}calendar/event/${enc(e.serverId)}${query({ account: e.jmapAccountId, appAccount: e.accountId })}`,
  contacts: () => `${base}contacts`,
  files: () => `${base}files`,
  settings: (tab?: string) => `${base}settings${tab ? `/${enc(tab)}` : ''}`,
};
