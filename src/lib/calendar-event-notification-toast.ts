import type { CalendarEventNotification } from '../api/types';
import type { TranslateFn } from '../stores/locale-store';
import { TOAST_HOST_SLOTS } from '../stores/toast-store';
import { plainDisplayText } from './display-text';

// The sender controls the name, the event title and the comment. They are
// shown as plain text only (never markup, never linkified) and cut to a sane
// length. The name and title are one-line labels: plainDisplayText drops
// every format character and line break, so a name cannot fake a second
// line. The comment is the toast's body and keeps its line breaks.
const MAX_NAME = 100;
const MAX_TITLE = 100;
const MAX_COMMENT = 200;

// The comment, cleaned line by line as the one-line labels are, so it drops
// the same format and control characters but keeps its line breaks.
function plainComment(value: string | null | undefined, max: number): string {
  if (!value) return '';
  const clean = value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => plainDisplayText(line, max))
    .join('\n')
    .trim();
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
    const message = plainComment(n.comment, MAX_COMMENT) || undefined;
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

// The toast host keeps TOAST_HOST_SLOTS toasts; a backlog toasted one by one
// would evict unrelated ones.

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

/**
 * How long a batch waits for a free toast slot. Three toasts the user must
 * keep (an Undo, errors) can sit for a long time; past this the batch is
 * acknowledged without a toast, so its notices don't stay queued forever.
 */
export const NOTICE_WAIT_CAP_MS = 60_000;

/**
 * Whether a waiting batch is shown now (there is room), waits on (no room,
 * the clock started at `waitingSince`) or is dropped (waited past the cap).
 * Showing or dropping it resets the clock.
 */
export function noticeWaitStep(
  waitingSince: number | null,
  now: number,
  room: number,
): { action: 'show' | 'wait' | 'drop'; waitingSince: number | null } {
  if (room > 0) return { action: 'show', waitingSince: null };
  if (waitingSince === null) return { action: 'wait', waitingSince: now };
  if (now - waitingSince >= NOTICE_WAIT_CAP_MS) return { action: 'drop', waitingSince: null };
  return { action: 'wait', waitingSince };
}

export interface NoticeWaiter {
  /** What to do with the waiting batch given `room` free slots; a wait arms the timer. */
  step(room: number): 'show' | 'drop' | 'wait';
  /** The batch is gone: stop the clock and the timer. */
  reset(): void;
}

/**
 * One presenter's wait for room: the clock of `noticeWaitStep` and a single
 * timer that calls `present` again when the wait reaches the cap, so a batch
 * is dropped even when no toast ever leaves.
 */
export function createNoticeWaiter(present: () => void): NoticeWaiter {
  let waitingSince: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    step(room) {
      const now = Date.now();
      const next = noticeWaitStep(waitingSince, now, room);
      waitingSince = next.waitingSince;
      clearTimer();
      if (next.action === 'wait') {
        timer = setTimeout(present, Math.max(0, next.waitingSince! + NOTICE_WAIT_CAP_MS - now));
      }
      return next.action;
    },
    reset() {
      waitingSince = null;
      clearTimer();
    },
  };
}
