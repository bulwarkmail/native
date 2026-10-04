import type { CalendarEventNotification } from '../api/types';
import type { TranslateFn } from '../stores/locale-store';

// The sender controls the name, the event title and the comment. They are
// shown as plain text only (never markup, never linkified), stripped of
// control and bidi-override characters and cut to a sane length.
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
    const name = plain(n.changedBy?.name, MAX_NAME)
      || plain(n.changedBy?.email, MAX_NAME)
      || t('calendar_event_notifications.someone', 'Someone');
    const title = plain(n.event?.title, MAX_TITLE)
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
const MAX_TOASTS = 3;
const INDIVIDUAL_WHEN_CROWDED = 2;

/**
 * Splits toasts (oldest first) into those shown one by one and a count of
 * the rest, which get one summary toast. Up to three are shown as they are;
 * a bigger batch keeps the newest two and summarises the others.
 */
export function selectNoticeToasts(toasts: NoticeToast[]): { individual: NoticeToast[]; overflow: number } {
  if (toasts.length <= MAX_TOASTS) return { individual: toasts, overflow: 0 };
  return {
    individual: toasts.slice(-INDIVIDUAL_WHEN_CROWDED),
    overflow: toasts.length - INDIVIDUAL_WHEN_CROWDED,
  };
}
