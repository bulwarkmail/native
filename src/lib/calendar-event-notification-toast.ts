import type { CalendarEventNotification } from '../api/types';
import type { TranslateFn } from '../stores/locale-store';
import { plainDisplayText } from './display-text';

// The sender controls the name, the event title and the comment. They are
// shown as plain text only (never markup, never linkified) and cut to a sane
// length. The name and title are one-line labels: plainDisplayText drops
// every format character and line break, so a name cannot fake a second
// line. The comment is the toast's body and keeps its line breaks.
const MAX_NAME = 100;
const MAX_TITLE = 100;
const MAX_COMMENT = 200;

// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g;

function plain(value: string | null | undefined, max: number): string {
  const clean = (value ?? '').replace(UNSAFE, '').trim();
  const chars = Array.from(clean);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : clean;
}

export interface NoticeToast {
  id: string;
  level: 'info' | 'warning';
  title: string;
  message?: string;
  /** Server id of the event to open, only when it can be loaded. */
  openEventId?: string;
}

/**
 * One toast per non-draft notice. `activeAccountId` is the account the client
 * serves now; an event is offered for opening only when the notice is for that
 * same account, the event still exists (not a cancellation) and has an id.
 */
export function buildNoticeToasts(
  notices: (CalendarEventNotification & { accountId?: string; appAccountId?: string })[],
  t: TranslateFn,
  activeAccountId?: string,
  activeAppAccountId?: string | null,
): NoticeToast[] {
  const out: NoticeToast[] = [];
  for (const n of notices) {
    // Drafts are the user's own unsent scheduling changes - nothing to announce.
    if (n.isDraft) continue;
    const name = plainDisplayText(n.changedBy?.name, MAX_NAME)
      || plainDisplayText(n.changedBy?.email, MAX_NAME)
      || t('calendar_event_notifications.someone', 'Someone');
    const title = plainDisplayText(n.event?.title, MAX_TITLE)
      || t('calendar_event_notifications.untitled', 'Untitled event');
    const params = { name, title };
    let level: NoticeToast['level'] = 'info';
    let text: string;
    if (n.type === 'created') {
      text = t('calendar_event_notifications.invited', '{name} invited you to "{title}"', params);
    } else if (n.type === 'destroyed') {
      level = 'warning';
      text = t('calendar_event_notifications.cancelled', '{name} cancelled "{title}"', params);
    } else {
      text = t('calendar_event_notifications.updated', '{name} updated "{title}"', params);
    }
    const message = plain(n.comment, MAX_COMMENT) || undefined;
    const loadable = n.type !== 'destroyed'
      && !!n.calendarEventId
      && !!activeAccountId
      && n.accountId === activeAccountId
      && (n.appAccountId ?? null) === (activeAppAccountId ?? null);
    out.push({
      id: n.id,
      level,
      title: text,
      message,
      ...(loadable ? { openEventId: n.calendarEventId } : {}),
    });
  }
  return out;
}

// The toast host keeps three toasts; a backlog toasted one by one would evict
// unrelated ones.
export const TOAST_HOST_SLOTS = 3;

/**
 * Splits toasts (oldest first) into those shown one by one and a count of
 * the rest, which get one summary toast, so that at most `room` toasts are
 * added (three by default). A batch that fits is shown as it is; a bigger
 * one keeps the newest `room - 1` and summarises the others.
 */
export function selectNoticeToasts<N>(
  toasts: N[],
  room: number = TOAST_HOST_SLOTS,
): { individual: N[]; overflow: number } {
  if (toasts.length <= room) return { individual: toasts, overflow: 0 };
  const keep = Math.max(0, room - 1);
  return {
    individual: keep > 0 ? toasts.slice(-keep) : [],
    overflow: toasts.length - keep,
  };
}
