import { describe, it, expect } from 'vitest';
import { outboxRows, queuedSendCount, unannouncedUnsent } from '../outbox-rows';
import type { QueuedSend, QueuedSendState } from '../../stores/send-queue-store';

function entry(id: string, state: QueuedSendState, extra: Partial<QueuedSend> = {}): QueuedSend {
  return {
    id,
    appAccountId: 'A',
    jmapAccountId: 'jA',
    identityId: 'i1',
    outgoing: { from: [{ email: 'me@x.org' }], to: [{ name: 'Bob', email: 'bob@x.org' }], subject: `S-${id}`, messageId: `m-${id}@x` },
    messageId: `m-${id}@x`,
    createdAt: `2026-10-04T10:00:0${id.length}Z`,
    state,
    ...extra,
  };
}
const base = { now: 0, activeAppAccountId: 'A', accountLabels: { A: 'me@a.org', B: 'me@b.org' } };

describe('outboxRows', () => {
  it('labels each state', () => {
    const rows = outboxRows([
      entry('1', 'queued'), entry('2', 'sending'), entry('3', 'uncertain'),
      entry('4', 'failed', { lastError: 'Quota' }), entry('5', 'failed'),
    ], base);
    expect(rows.map((r) => r.stateLabel.key)).toEqual([
      'outbox.state.queued', 'outbox.state.sending', 'outbox.state.uncertain',
      'outbox.state.failed', 'outbox.state.failed_unknown',
    ]);
    expect(rows[3].stateLabel.params).toEqual({ error: 'Quota' });
    expect(rows[0].subject).toBe('S-1');
    expect(rows[0].recipients).toEqual(['Bob']);
  });

  it('shows the waiting-for-account state with the account label', () => {
    const [row] = outboxRows([entry('1', 'queued', { appAccountId: 'B' })], base);
    expect(row.stateLabel.key).toBe('outbox.state.waiting_account');
    expect(row.stateLabel.params).toEqual({ account: 'me@b.org' });
    expect(row.waitingForAccount).toBe(true);
    expect(row.actions).toEqual(['discard']);
  });

  it('falls back to the account id when it has no label', () => {
    const [row] = outboxRows([entry('1', 'queued', { appAccountId: 'Z' })], base);
    expect(row.stateLabel.params).toEqual({ account: 'Z' });
  });

  it('keeps the failed/uncertain label for another account and withholds retry and send again', () => {
    const rows = outboxRows([
      entry('1', 'failed', { appAccountId: 'B' }), entry('22', 'uncertain', { appAccountId: 'B' }),
    ], base);
    for (const r of rows) {
      expect(r.actions).toEqual(['discard']);
      expect(r.accountNote?.key).toBe('outbox.state.waiting_account');
    }
    expect(rows[0].stateLabel.key).toBe('outbox.state.failed_unknown');
    expect(rows[1].stateLabel.key).toBe('outbox.state.uncertain');
  });

  it('a sending row from another account is still just sending', () => {
    const [row] = outboxRows([entry('1', 'sending', { appAccountId: 'B' })], base);
    expect(row.stateLabel.key).toBe('outbox.state.sending');
    expect(row.actions).toEqual([]);
  });

  it('orders oldest first across accounts', () => {
    const rows = outboxRows([
      entry('a', 'queued', { createdAt: '2026-10-04T12:00:00Z' }),
      entry('b', 'queued', { createdAt: '2026-10-04T09:00:00Z', appAccountId: 'B' }),
      entry('c', 'queued', { createdAt: '2026-10-04T10:00:00Z' }),
    ], base);
    expect(rows.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('offers exactly these actions per state (active account, online)', () => {
    const acts = (s: QueuedSendState) => outboxRows([entry('1', s)], base)[0].actions;
    expect(acts('queued')).toEqual(['save_draft', 'discard']);
    expect(acts('failed')).toEqual(['retry', 'save_draft', 'discard']);
    expect(acts('uncertain')).toEqual(['send_again', 'save_draft', 'discard']);
    expect(acts('sending')).toEqual([]);
  });

  it('never offers retry on a queued or send again on a failed row', () => {
    expect(outboxRows([entry('1', 'queued')], base)[0].actions).not.toContain('retry');
    expect(outboxRows([entry('1', 'failed')], base)[0].actions).not.toContain('send_again');
  });

  it('drops save as draft while offline', () => {
    const acts = (s: QueuedSendState) => outboxRows([entry('1', s)], { ...base, online: false })[0].actions;
    expect(acts('queued')).toEqual(['discard']);
    expect(acts('failed')).toEqual(['retry', 'discard']);
    expect(acts('uncertain')).toEqual(['send_again', 'discard']);
  });

  it('labels a held entry by its reason and offers Retry, Save as draft and Discard', () => {
    const reasons = ['bad_schedule', 'no_sent', 'no_drafts', 'account_unavailable'] as const;
    const rows = outboxRows(reasons.map((r, i) => entry(String(i + 1).repeat(i + 1), 'queued', { heldReason: r })), base);
    expect(rows.map((r) => r.stateLabel.key)).toEqual(reasons.map((r) => `outbox.held.${r}`));
    for (const r of rows) {
      expect(r.held).toBe(true);
      expect(r.actions).toEqual(['retry', 'save_draft', 'discard']);
      expect(r.stateLabel.fallback).toBeTruthy();
    }
    const plain = outboxRows([entry('1', 'queued')], base)[0];
    expect(plain.held).toBe(false);
  });

  it('a held entry offline keeps Retry and Discard; in another account only Discard, with the account note', () => {
    const [off] = outboxRows([entry('1', 'queued', { heldReason: 'no_sent' })], { ...base, online: false });
    expect(off.actions).toEqual(['retry', 'discard']);
    const [other] = outboxRows([entry('1', 'queued', { heldReason: 'no_sent', appAccountId: 'B' })], base);
    expect(other.stateLabel.key).toBe('outbox.held.no_sent');
    expect(other.accountNote?.key).toBe('outbox.state.waiting_account');
    expect(other.actions).toEqual(['discard']);
  });

  it('an unknown hold reason still reads as held, never as waiting for connection', () => {
    const [row] = outboxRows([entry('1', 'queued', { heldReason: 'weird' as never })], base);
    expect(row.stateLabel.key).toBe('outbox.held.unknown');
    expect(row.actions).toContain('retry');
  });

  it('summarises many recipients and tolerates none', () => {
    const many = entry('1', 'queued', {
      outgoing: { from: [], to: ['a', 'b', 'c', 'd', 'e'].map((n) => ({ email: `${n}@x.org` })), subject: '', messageId: 'm' },
    });
    const [row] = outboxRows([many], base);
    expect(row.recipients).toEqual(['a@x.org', 'b@x.org', 'c@x.org', '+2']);
    expect(row.subject).toBeNull();
    const none = entry('2', 'queued', { outgoing: { from: [], to: [], subject: 's', messageId: 'm' } });
    expect(outboxRows([none], base)[0].recipients).toEqual([]);
  });
});

describe('queuedSendCount / unannouncedUnsent', () => {
  it('counts across accounts', () => {
    expect(queuedSendCount({ A: [entry('1', 'queued')], B: [entry('2', 'failed'), entry('3', 'sending')] })).toBe(3);
  });

  it('announces a failed or uncertain entry once, again only after it left that state', () => {
    const notified = new Set<string>();
    const s1 = { A: [entry('1', 'queued'), entry('2', 'failed'), entry('3', 'uncertain')] };
    expect(unannouncedUnsent(s1, notified).map((e) => e.id)).toEqual(['2', '3']);
    expect(unannouncedUnsent(s1, notified)).toEqual([]);
    unannouncedUnsent({ A: [entry('2', 'queued'), entry('3', 'uncertain')] }, notified);
    expect(unannouncedUnsent({ A: [entry('2', 'failed'), entry('3', 'uncertain')] }, notified).map((e) => e.id)).toEqual(['2']);
  });
});

describe('unannouncedUnsent: held entries', () => {
  it('announces a held entry once, and again only after a Retry cleared the hold', () => {
    const notified = new Set<string>();
    const held = { A: [entry('1', 'queued', { heldReason: 'no_drafts' })] };
    expect(unannouncedUnsent(held, notified).map((e) => e.id)).toEqual(['1']);
    expect(unannouncedUnsent(held, notified)).toEqual([]);
    unannouncedUnsent({ A: [entry('1', 'queued')] }, notified);
    expect(unannouncedUnsent(held, notified).map((e) => e.id)).toEqual(['1']);
  });
});
