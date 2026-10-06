// Buttons that act without opening the app: archive / delete / next on the
// triage card, RSVP on the invitation card, ticking a task. Each one lays its
// change over the stored data at once (./state.ts) so every widget redraws
// without waiting, then makes the JMAP call. A change the server took stays
// laid over the data until a refresh has caught up with it; one that failed
// is dropped again, which shows the data as the server last described it,
// and the widget says so with a notice that repeats the tap.

import { jmapClient } from '../api/jmap-client';
import type { JMAPClient } from '../api/jmap-client';
import { refreshSnapshot, singletonServes } from './build';
import { markRead, moveTo, openClient, rsvp, setTaskDone } from './jmap';
import { loadLocal, saveLocal } from './local-state';
import { pinToConnection } from './pinned-client';
import type { PendingChange } from './pending';
import type { ActionNotice } from './snapshot';
import { redrawAll } from './render';
import { serial } from './serial';
import { currentView, settle, track } from './state';

async function clientFor(registryAccountId: string | null | undefined): Promise<JMAPClient | null> {
  if (!registryAccountId) return null;
  // The app's own client, held to this connection for the whole action.
  if (singletonServes(registryAccountId)) return pinToConnection(jmapClient);
  return openClient(registryAccountId);
}

type Data = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/**
 * Lay `change` over the data, run `call`, and keep or drop the change by its
 * answer. On failure the widget shows a notice about `label` that repeats
 * the tap (`name` with `data`).
 */
async function apply(
  name: ActionNotice['action'],
  data: Data,
  label: string,
  change: PendingChange,
  call: () => Promise<boolean>,
  onFailed?: () => Promise<void>,
): Promise<boolean> {
  const key = await track(change);
  await redrawAll();
  let ok = false;
  try {
    ok = await call();
  } catch (err) {
    console.warn(`[widgets] ${name} failed`, err);
  }
  if (!ok) console.warn(`[widgets] ${name} was not applied on the server`);
  await settle(key, ok, { action: name, label, at: Date.now(), retry: data });
  if (!ok) await onFailed?.();
  await redrawAll();
  // Catch up with the server: confirms a change that went through and picks
  // up whatever else changed. Offline this fails quickly and keeps the data.
  await refreshSnapshot({ after: 'change' });
  await redrawAll();
  return ok;
}

/** The triage card's message after `id`, among what the widget shows now. */
async function moveTriagePointer(widgetId: number, id: string): Promise<void> {
  const view = await currentView();
  const unread = view.mail.inbox.filter((m) => m.unread);
  const index = unread.findIndex((m) => m.id === id);
  const next = index >= 0 ? unread[index + 1] ?? unread[index - 1] : undefined;
  await pointTriage(widgetId, next?.id ?? null);
}

function pointTriage(widgetId: number, triageId: string | null): Promise<void> {
  return serial(async () => saveLocal(widgetId, { ...(await loadLocal(widgetId)), triageId }));
}

export async function handleWidgetAction(name: string, data: Data, widgetId: number): Promise<void> {
  switch (name) {
    case 'refresh':
      await refreshSnapshot({ after: 'change' });
      await redrawAll();
      return;

    case 'triageNext': {
      const view = await currentView();
      const unread = view.mail.inbox.filter((m) => m.unread);
      if (unread.length === 0) return;
      const index = unread.findIndex((m) => m.id === data.id);
      const next = unread[(index + 1) % unread.length];
      await pointTriage(widgetId, next.id);
      await redrawAll();
      return;
    }

    case 'archive':
    case 'trash':
    case 'markRead': {
      const id = str(data.id);
      if (!id) return;
      const subject = (await currentView()).mail.inbox.find((m) => m.id === id)?.subject ?? '';
      // The triage card moves on to the next unread message, not back to
      // the first one.
      if (name !== 'markRead') await moveTriagePointer(widgetId, id);
      const accountId = str(data.accountId);
      const jmapAccountId = str(data.jmapAccountId);
      const change: PendingChange = name === 'markRead' ? { kind: 'markRead', id } : { kind: 'removeMail', id };
      await apply(name, data, subject, change, async () => {
        const client = await clientFor(accountId);
        if (!client) return false;
        return name === 'markRead'
          ? markRead(client, id, jmapAccountId)
          : moveTo(client, id, name, jmapAccountId);
      }, async () => {
        // The card goes back to the message, next to the notice about it.
        if (name !== 'markRead') await pointTriage(widgetId, id);
      });
      return;
    }

    case 'rsvp': {
      const id = str(data.id);
      const status = data.status;
      if (!id || (status !== 'accepted' && status !== 'tentative' && status !== 'declined')) return;
      // The tap carries the invitation (clicks.ts); a drawing made before it
      // did is looked up in what the widgets show now.
      const view = await currentView();
      const shown = view.calendar.invitations.find((i) => i.id === id);
      const accountId = str(data.accountId) ?? shown?.accountId ?? view.activeAccountId;
      const serverId = str(data.serverId) ?? shown?.serverId;
      const participantId = str(data.participantId) ?? shown?.participantId;
      const jmapAccountId = str(data.jmapAccountId) ?? (str(data.serverId) ? undefined : shown?.jmapAccountId);
      if (!serverId || !participantId) {
        await redrawAll();
        return;
      }
      const title = str(data.title) ?? shown?.title ?? '';
      await apply('rsvp', data, title, { kind: 'rsvp', id, serverId, status, accountId: accountId ?? undefined }, async () => {
        const client = await clientFor(accountId);
        return !!client && rsvp(client, serverId, participantId, status, jmapAccountId);
      });
      return;
    }

    case 'toggleTask': {
      const id = str(data.id);
      if (!id) return;
      const view = await currentView();
      const shown = view.tasks.items.find((t) => t.id === id);
      const accountId = str(data.accountId) ?? shown?.accountId ?? view.activeAccountId;
      const serverId = str(data.serverId) ?? shown?.serverId;
      const jmapAccountId = str(data.jmapAccountId) ?? (str(data.serverId) ? undefined : shown?.jmapAccountId);
      // The state the user asked for; older drawings only named the task.
      const done = typeof data.done === 'boolean' ? data.done : shown ? !shown.done : undefined;
      if (!serverId || done === undefined) {
        await redrawAll();
        return;
      }
      const title = str(data.title) ?? shown?.title ?? '';
      await apply('toggleTask', data, title, { kind: 'task', id, done, accountId: accountId ?? undefined }, async () => {
        const client = await clientFor(accountId);
        if (!client || !(await setTaskDone(client, serverId, done, jmapAccountId))) return false;
        // In the live app the snapshot's tasks come from the calendar store,
        // which did not see this change; reload it before the refresh that
        // follows reads it, or that refresh would undo the tick.
        if (client === jmapClient && accountId) {
          const { reloadWidgetTasks } = require('./calendar-load') as typeof import('./calendar-load');
          await reloadWidgetTasks(accountId).catch(() => undefined);
        }
        return true;
      });
      return;
    }

    default:
      console.warn(`[widgets] unknown action ${name}`);
  }
}
