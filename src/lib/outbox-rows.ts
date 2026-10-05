// Pure view model for the Outbox screen: the queued sends, oldest first, each
// with its state label and exactly the actions that are safe to offer.
//
// Safety rules baked in here (the screen only renders what this returns):
// - `sending` offers nothing: a request may be in flight.
// - Retry / Send again need the entry's own account to be the active one,
//   because replay only runs for the active account.
// - Save as draft needs the connection and the entry's account to be active
//   (the JMAP client only serves the active account).
// - Discard is always offered except while `sending`.
import type { QueuedSend, QueuedSendState } from '../stores/send-queue-store';

export type OutboxAction = 'retry' | 'send_again' | 'save_draft' | 'discard';

export interface OutboxLabel {
  key: string;
  fallback: string;
  params?: Record<string, string | number>;
}

export interface OutboxRow {
  id: string;
  entry: QueuedSend;
  subject: string | null;
  /** Display names or addresses of the To recipients; empty when there are none. */
  recipients: string[];
  state: QueuedSendState;
  stateLabel: OutboxLabel;
  /** True when the entry belongs to an account that is not the active one. */
  waitingForAccount: boolean;
  /** Shown under failed/uncertain rows whose account is not active. */
  accountNote: OutboxLabel | null;
  actions: OutboxAction[];
  createdAt: string;
}

export interface OutboxRowsOptions {
  now: number;
  activeAppAccountId: string | null;
  /** App account id -> email or username. */
  accountLabels: Record<string, string>;
  /** Network state; Save as draft is offered only while online. Defaults to true. */
  online?: boolean;
}

const MAX_RECIPIENTS = 3;

function waitingLabel(entry: QueuedSend, labels: Record<string, string>): OutboxLabel {
  return {
    key: 'outbox.state.waiting_account',
    fallback: 'Waiting — switch to {account} to send',
    params: { account: labels[entry.appAccountId] || entry.appAccountId },
  };
}

function stateLabel(entry: QueuedSend): OutboxLabel {
  switch (entry.state) {
    case 'queued':
      return { key: 'outbox.state.queued', fallback: 'Waiting for connection' };
    case 'sending':
      return { key: 'outbox.state.sending', fallback: 'Sending…' };
    case 'uncertain':
      return { key: 'outbox.state.uncertain', fallback: 'May have been sent — check Sent' };
    case 'failed':
      return entry.lastError
        ? { key: 'outbox.state.failed', fallback: 'Not sent: {error}', params: { error: entry.lastError } }
        : { key: 'outbox.state.failed_unknown', fallback: 'Not sent' };
  }
}

function recipientNames(entry: QueuedSend): string[] {
  const to = Array.isArray(entry.outgoing?.to) ? entry.outgoing.to : [];
  const names = to.map((a) => a?.name || a?.email).filter((s): s is string => !!s);
  return names.length > MAX_RECIPIENTS
    ? [...names.slice(0, MAX_RECIPIENTS), `+${names.length - MAX_RECIPIENTS}`]
    : names;
}

function actionsFor(state: QueuedSendState, active: boolean, online: boolean): OutboxAction[] {
  const out: OutboxAction[] = [];
  if (state === 'sending') return out;
  if (active && state === 'failed') out.push('retry');
  if (active && state === 'uncertain') out.push('send_again');
  if (active && online) out.push('save_draft');
  out.push('discard');
  return out;
}

/** Entries across all accounts, oldest first (ties keep their input order). */
export function outboxRows(entries: readonly QueuedSend[], opts: OutboxRowsOptions): OutboxRow[] {
  const online = opts.online ?? true;
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (a.entry.createdAt < b.entry.createdAt ? -1 : a.entry.createdAt > b.entry.createdAt ? 1 : a.index - b.index))
    .map(({ entry }) => {
      const active = entry.appAccountId === opts.activeAppAccountId;
      const waiting = !active && entry.state !== 'sending';
      const note = waiting ? waitingLabel(entry, opts.accountLabels) : null;
      return {
        id: entry.id,
        entry,
        subject: entry.outgoing?.subject || null,
        recipients: recipientNames(entry),
        state: entry.state,
        stateLabel: waiting && entry.state === 'queued' ? (note as OutboxLabel) : stateLabel(entry),
        waitingForAccount: waiting,
        accountNote: waiting && entry.state !== 'queued' ? note : null,
        actions: actionsFor(entry.state, active, online),
        createdAt: entry.createdAt,
      };
    });
}

/** All loaded entries, flattened. */
export function allQueuedSends(entries: Record<string, QueuedSend[]>): QueuedSend[] {
  return Object.values(entries).flat();
}

export function queuedSendCount(entries: Record<string, QueuedSend[]>): number {
  let n = 0;
  for (const list of Object.values(entries)) n += list.length;
  return n;
}

/**
 * Entries now `failed` or `uncertain` that were not announced yet. Ids no
 * longer in either state are forgotten, so a retry that fails again is
 * announced again. Mutates `notified`.
 */
export function unannouncedUnsent(entries: Record<string, QueuedSend[]>, notified: Set<string>): QueuedSend[] {
  const current = new Set<string>();
  const fresh: QueuedSend[] = [];
  for (const e of allQueuedSends(entries)) {
    if (e.state !== 'failed' && e.state !== 'uncertain') continue;
    current.add(e.id);
    if (!notified.has(e.id)) fresh.push(e);
  }
  for (const id of [...notified]) if (!current.has(id)) notified.delete(id);
  for (const e of fresh) notified.add(e.id);
  return fresh;
}
