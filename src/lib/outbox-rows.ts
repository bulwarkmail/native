// Pure view model for the Outbox screen: the queued sends, oldest first, each
// with its state label and exactly the actions that are safe to offer.
//
// Safety rules baked in here (the screen only renders what this returns):
// - `sending` offers nothing: a request may be in flight.
// - A held `queued` entry (replay cannot send it) says why and offers Retry.
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
  /** A `queued` entry replay holds (heldReason set): it waits for the user's Retry. */
  held: boolean;
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

function heldLabel(entry: QueuedSend): OutboxLabel {
  switch (entry.heldReason) {
    case 'bad_schedule':
      return { key: 'outbox.held.bad_schedule', fallback: 'Not sent: the scheduled time could not be read' };
    case 'no_sent':
      return { key: 'outbox.held.no_sent', fallback: 'Not sent: this account has no Sent folder' };
    case 'no_drafts':
      return { key: 'outbox.held.no_drafts', fallback: 'Not sent: this account has no Drafts folder' };
    case 'account_unavailable':
      return { key: 'outbox.held.account_unavailable', fallback: 'Not sent: this account is not available' };
    default:
      return { key: 'outbox.held.unknown', fallback: 'Not sent: this message cannot be sent now' };
  }
}

function isHeld(entry: QueuedSend): boolean {
  return entry.state === 'queued' && !!entry.heldReason;
}

function stateLabel(entry: QueuedSend): OutboxLabel {
  if (isHeld(entry)) return heldLabel(entry);
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

function actionsFor(state: QueuedSendState, held: boolean, active: boolean, online: boolean): OutboxAction[] {
  const out: OutboxAction[] = [];
  if (state === 'sending') return out;
  if (active && (state === 'failed' || held)) out.push('retry');
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
      const held = isHeld(entry);
      const waiting = !active && entry.state !== 'sending';
      const note = waiting ? waitingLabel(entry, opts.accountLabels) : null;
      // A plain queued entry of another account just waits for it; anything
      // else keeps its own label, with the account as a note.
      const waitingOnly = waiting && entry.state === 'queued' && !held;
      return {
        id: entry.id,
        entry,
        subject: entry.outgoing?.subject || null,
        recipients: recipientNames(entry),
        state: entry.state,
        held,
        stateLabel: waitingOnly ? (note as OutboxLabel) : stateLabel(entry),
        waitingForAccount: waiting,
        accountNote: waiting && !waitingOnly ? note : null,
        actions: actionsFor(entry.state, held, active, online),
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
 * Entries now `failed`, `uncertain` or held that were not announced yet. Ids
 * no longer in any of these are forgotten, so a retry that fails (or is held)
 * again is announced again. Mutates `notified`.
 */
export function unannouncedUnsent(entries: Record<string, QueuedSend[]>, notified: Set<string>): QueuedSend[] {
  const current = new Set<string>();
  const fresh: QueuedSend[] = [];
  for (const e of allQueuedSends(entries)) {
    if (e.state !== 'failed' && e.state !== 'uncertain' && !isHeld(e)) continue;
    current.add(e.id);
    if (!notified.has(e.id)) fresh.push(e);
  }
  for (const id of [...notified]) if (!current.has(id)) notified.delete(id);
  for (const e of fresh) notified.add(e.id);
  return fresh;
}
