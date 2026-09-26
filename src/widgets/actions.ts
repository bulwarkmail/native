// Buttons that act without opening the app: archive / delete / next on the
// triage card, RSVP on the invitation card, ticking a task. Each one updates
// the stored snapshot first so every widget redraws at once, then makes the
// JMAP call, then refreshes from the server; a failed call is undone by that
// refresh.

import { jmapClient } from '../api/jmap-client';
import type { JMAPClient } from '../api/jmap-client';
import { noteLocalChange, refreshSnapshot, singletonServes } from './build';
import { markRead, moveTo, openClient, rsvp, setTaskDone } from './jmap';
import { loadLocal, saveLocal } from './local-state';
import { updateAllWidgets } from './render';
import { emptySnapshot, loadSnapshot, saveSnapshot, type MailItem, type WidgetSnapshot } from './snapshot';

async function clientFor(registryAccountId: string | null | undefined): Promise<JMAPClient | null> {
  if (!registryAccountId) return null;
  if (singletonServes(registryAccountId)) return jmapClient;
  return openClient(registryAccountId);
}

async function applyLocally(mutate: (s: WidgetSnapshot) => void): Promise<WidgetSnapshot> {
  noteLocalChange();
  const s = (await loadSnapshot()) ?? emptySnapshot();
  mutate(s);
  await saveSnapshot(s);
  await updateAllWidgets(s);
  return s;
}

function withoutMessage(s: WidgetSnapshot, id: string): void {
  const removed = s.mail.inbox.find((m) => m.id === id);
  const drop = (list: MailItem[]) => list.filter((m) => m.id !== id);
  s.mail.inbox = drop(s.mail.inbox);
  s.mail.unified = drop(s.mail.unified);
  s.mail.starred = drop(s.mail.starred);
  const inbox = s.mail.folders.find((f) => f.role === 'inbox');
  if (inbox && removed) {
    inbox.total = Math.max(0, inbox.total - 1);
    if (removed.unread) inbox.unread = Math.max(0, inbox.unread - 1);
  }
}

async function afterServerCall(ok: boolean): Promise<void> {
  if (!ok) console.warn('[widgets] action was not applied on the server');
  const fresh = await refreshSnapshot({ after: 'change' });
  await updateAllWidgets(fresh);
}

type Data = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export async function handleWidgetAction(name: string, data: Data, widgetId: number): Promise<void> {
  switch (name) {
    case 'refresh':
      await afterServerCall(true);
      return;

    case 'triageNext': {
      const s = (await loadSnapshot()) ?? emptySnapshot();
      const unread = s.mail.inbox.filter((m) => m.unread);
      if (unread.length === 0) return;
      const index = unread.findIndex((m) => m.id === data.id);
      const next = unread[(index + 1) % unread.length];
      const local = await loadLocal(widgetId);
      await saveLocal(widgetId, { ...local, triageId: next.id });
      await updateAllWidgets(s);
      return;
    }

    case 'archive':
    case 'trash':
    case 'markRead': {
      const id = str(data.id);
      if (!id) return;
      if (name === 'markRead') {
        await applyLocally((s) => {
          const hit = s.mail.inbox.find((m) => m.id === id);
          const inbox = s.mail.folders.find((f) => f.role === 'inbox');
          if (hit?.unread && inbox) inbox.unread = Math.max(0, inbox.unread - 1);
          for (const list of [s.mail.inbox, s.mail.unified, s.mail.starred]) {
            for (const m of list) if (m.id === id) m.unread = false;
          }
        });
      } else {
        // The triage card moves on to the next unread message, not back to
        // the first one.
        const before = (await loadSnapshot()) ?? emptySnapshot();
        const unread = before.mail.inbox.filter((m) => m.unread);
        const index = unread.findIndex((m) => m.id === id);
        const next = index >= 0 ? unread[index + 1] ?? unread[index - 1] : undefined;
        if (typeof data.widgetId === 'number') {
          await saveLocal(data.widgetId, { ...(await loadLocal(data.widgetId)), triageId: next?.id ?? null });
        }
        await applyLocally((s) => withoutMessage(s, id));
      }
      let ok = false;
      try {
        const client = await clientFor(str(data.accountId));
        if (client) {
          ok = name === 'markRead'
            ? await markRead(client, id, str(data.jmapAccountId))
            : await moveTo(client, id, name, str(data.jmapAccountId));
        }
      } catch (err) {
        console.warn(`[widgets] ${name} failed`, err);
      }
      await afterServerCall(ok);
      return;
    }

    case 'rsvp': {
      const id = str(data.id);
      const status = data.status;
      if (!id || (status !== 'accepted' && status !== 'tentative' && status !== 'declined')) return;
      const before = (await loadSnapshot()) ?? emptySnapshot();
      const invitation = before.calendar.invitations.find((i) => i.id === id);
      if (!invitation) return;
      await applyLocally((s) => {
        s.calendar.invitations = s.calendar.invitations.filter((i) => i.id !== id);
        for (const e of s.calendar.events) if (e.serverId === invitation.serverId) e.myStatus = status;
      });
      let ok = false;
      try {
        const client = await clientFor(before.activeAccountId);
        if (client) ok = await rsvp(client, invitation.serverId, invitation.participantId, status, invitation.jmapAccountId);
      } catch (err) {
        console.warn('[widgets] rsvp failed', err);
      }
      await afterServerCall(ok);
      return;
    }

    case 'toggleTask': {
      const id = str(data.id);
      if (!id) return;
      const before = (await loadSnapshot()) ?? emptySnapshot();
      const task = before.tasks.items.find((t) => t.id === id);
      if (!task) return;
      const done = !task.done;
      await applyLocally((s) => {
        for (const t of s.tasks.items) if (t.id === id) t.done = done;
      });
      let ok = false;
      try {
        const client = await clientFor(before.activeAccountId);
        if (client) ok = await setTaskDone(client, task.serverId, done, task.jmapAccountId);
        // In the live app the snapshot's tasks come from the calendar store,
        // which did not see this change; reload it so the refresh keeps it.
        if (ok && before.activeAccountId && singletonServes(before.activeAccountId)) {
          const { useCalendarStore } = require('../stores/calendar-store') as typeof import('../stores/calendar-store');
          await useCalendarStore.getState().fetchTasks();
        }
      } catch (err) {
        console.warn('[widgets] task toggle failed', err);
      }
      await afterServerCall(ok);
      return;
    }

    default:
      console.warn(`[widgets] unknown action ${name}`);
  }
}
