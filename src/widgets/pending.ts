// Changes a widget button made that the stored snapshot does not show yet.
// The snapshot holds what the server last said; these are laid over it when
// a widget draws, so a refresh that read the server before the change landed
// cannot bring an archived message back, and a change the server refused is
// undone by dropping it rather than by hoping the next refresh gets through.
//
// An op is pending until the server answers, then done: it stays until a
// refresh that started after the server took it has replaced the data it
// covers (mail, or the calendar/tasks part that only some refreshes load).

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { WidgetActionName } from './clicks';
import type { ActionNotice, WidgetSnapshot } from './snapshot';

export const PENDING_KEY = 'widgets:pending:v1';

export type PendingChange =
  | { kind: 'removeMail'; id: string }
  | { kind: 'markRead'; id: string }
  // `accountId`: the signed-in account the item belongs to. JMAP ids are
  // only unique within an account, so the change must not touch another
  // account's item with the same id once the widgets show that account.
  | { kind: 'rsvp'; id: string; serverId: string; status: 'accepted' | 'tentative' | 'declined'; accountId?: string }
  | { kind: 'task'; id: string; done: boolean; accountId?: string };

export interface PendingOp {
  /** Unique per tap. */
  key: string;
  change: PendingChange;
  /** When the tap was made. */
  at: number;
  /** When the server took the change; absent while it is in flight. */
  doneAt?: number;
}

export interface PendingState {
  ops: PendingOp[];
  /** The last button change that did not reach the server, until it is retried or goes stale. */
  notice?: ActionNotice | null;
}

/** A done op the next refreshes never confirmed is dropped after this long. */
export const DONE_TTL_MS = 30 * 60 * 1000;
/** An op still in flight after this long belongs to a task that died. */
export const IN_FLIGHT_TTL_MS = 2 * 60 * 1000;
/** How long a failure notice stays on the widget. */
export const NOTICE_TTL_MS = 10 * 60 * 1000;

export function emptyPending(): PendingState {
  return { ops: [] };
}

export async function loadPending(): Promise<PendingState> {
  try {
    const raw = await AsyncStorage.getItem(PENDING_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<PendingState>) : null;
    return {
      ops: Array.isArray(parsed?.ops) ? parsed!.ops : [],
      notice: parsed?.notice && typeof parsed.notice === 'object' ? parsed.notice : null,
    };
  } catch {
    return emptyPending();
  }
}

export async function savePending(state: PendingState): Promise<void> {
  await AsyncStorage.setItem(PENDING_KEY, JSON.stringify(state));
}

const isMail = (c: PendingChange) => c.kind === 'removeMail' || c.kind === 'markRead';

/** Drop what has expired: in-flight ops of a task that died, done ops no refresh confirmed, an old notice. */
export function expire(state: PendingState, now: number): PendingState {
  return {
    ops: state.ops.filter((o) => (o.doneAt ? now - o.doneAt < DONE_TTL_MS : now - o.at < IN_FLIGHT_TTL_MS)),
    notice: state.notice && now - state.notice.at < NOTICE_TTL_MS ? state.notice : null,
  };
}

/** Which widget buttons a notice belongs to. */
export function noticeFor(notice: ActionNotice | null | undefined, ...actions: WidgetActionName[]): ActionNotice | null {
  return notice && actions.includes(notice.action) ? notice : null;
}

/**
 * After a refresh that started at `startedAt` was stored: the done ops it
 * covers are now part of the snapshot. Mail is always refreshed; calendar and
 * tasks only when `appData` is set.
 */
export function confirmedBy(ops: PendingOp[], startedAt: number, appData: boolean): PendingOp[] {
  return ops.filter((o) => !(o.doneAt !== undefined && o.doneAt < startedAt && (appData || isMail(o.change))));
}

/** The snapshot as the widgets should show it: the stored one with every op applied. */
export function applyPending(s: WidgetSnapshot, ops: PendingOp[]): WidgetSnapshot {
  if (ops.length === 0) return s;
  const next: WidgetSnapshot = {
    ...s,
    mail: {
      ...s.mail,
      folders: s.mail.folders.map((f) => ({ ...f })),
      inbox: [...s.mail.inbox],
      unified: [...s.mail.unified],
      starred: [...s.mail.starred],
    },
    calendar: { ...s.calendar, events: [...s.calendar.events], invitations: [...s.calendar.invitations] },
    tasks: { ...s.tasks, items: [...s.tasks.items] },
  };
  for (const { change } of ops) {
    switch (change.kind) {
      case 'removeMail': {
        const removed = next.mail.inbox.find((m) => m.id === change.id);
        const drop = <T extends { id: string }>(list: T[]) => list.filter((m) => m.id !== change.id);
        next.mail.inbox = drop(next.mail.inbox);
        next.mail.unified = drop(next.mail.unified);
        next.mail.starred = drop(next.mail.starred);
        const inbox = next.mail.folders.find((f) => f.role === 'inbox');
        if (inbox && removed) {
          inbox.total = Math.max(0, inbox.total - 1);
          if (removed.unread) inbox.unread = Math.max(0, inbox.unread - 1);
        }
        break;
      }
      case 'markRead': {
        const hit = next.mail.inbox.find((m) => m.id === change.id);
        const inbox = next.mail.folders.find((f) => f.role === 'inbox');
        if (hit?.unread && inbox) inbox.unread = Math.max(0, inbox.unread - 1);
        const read = <T extends { id: string; unread: boolean }>(list: T[]) =>
          list.map((m) => (m.id === change.id && m.unread ? { ...m, unread: false } : m));
        next.mail.inbox = read(next.mail.inbox);
        next.mail.unified = read(next.mail.unified);
        next.mail.starred = read(next.mail.starred);
        break;
      }
      case 'rsvp':
        if (change.accountId && change.accountId !== s.activeAccountId) break;
        next.calendar.invitations = next.calendar.invitations.filter(
          (i) => i.id !== change.id && i.serverId !== change.serverId,
        );
        next.calendar.events = next.calendar.events.map((e) =>
          (e.serverId === change.serverId && e.myStatus ? { ...e, myStatus: change.status } : e));
        break;
      case 'task':
        if (change.accountId && change.accountId !== s.activeAccountId) break;
        next.tasks.items = next.tasks.items.map((t) => (t.id === change.id ? { ...t, done: change.done } : t));
        break;
    }
  }
  return next;
}
