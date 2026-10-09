import { describe, it, expect } from 'vitest';
import { mayRestamp, restampTarget } from '../queue-restamp';
import type { QueuedSend } from '../../stores/send-queue-store';

const held: QueuedSend = {
  id: 'q1', appAccountId: 'A', jmapAccountId: 'jOld', identityId: 'i1',
  outgoing: { from: [{ email: 'me@x.example' }], to: [{ email: 'you@y.example' }], subject: 's', textBody: 'hi', messageId: 'mid-1@x.example' },
  messageId: 'mid-1@x.example', createdAt: '2026-10-04T08:00:00.000Z', state: 'queued', heldReason: 'account_unavailable',
};
const identity = (id: string, email: string) => ({ id, email, name: '', mayDelete: true });
const live = { primaryId: 'jNew', servesEntryAccount: false, identities: [identity('i1', 'me@x.example')] };
const withAttachment = { outgoing: { ...held.outgoing, attachments: [{ blobId: 'b1', type: 'text/plain', name: 'a.txt' }] } };

describe('restampTarget', () => {
  it('re-stamps a held, never-tried send onto the live primary when its identity matches', () => {
    expect(restampTarget(held, { primaryId: 'jNew', servesEntryAccount: false, identities: [identity('i1', 'Me@X.example')] })).toBe('jNew');
  });

  it.each([
    ['attempted', { attemptStartedAt: 't' }],
    ['with attachments', withAttachment],
    ['another hold', { heldReason: 'no_sent' as const }],
    ['not held', { heldReason: undefined }],
    ['uncertain', { state: 'uncertain' as const }],
    ['failed', { state: 'failed' as const }],
    ['sending', { state: 'sending' as const }],
    ['with an error from an earlier attempt', { lastError: 'Connection lost' }],
  ])('never re-stamps an entry %s', (_l, patch) => {
    expect(restampTarget({ ...held, ...patch }, live)).toBeNull();
  });

  it('never re-stamps onto an identity with another address', () => {
    expect(restampTarget(held, { ...live, identities: [identity('i1', 'other@x.example')] })).toBeNull();
  });

  it('never re-stamps when the primary has no identity with the entry\'s id', () => {
    expect(restampTarget(held, { ...live, identities: [identity('i2', 'me@x.example')] })).toBeNull();
    expect(restampTarget(held, { ...live, identities: [] })).toBeNull();
  });

  it('never re-stamps an entry that names no sender', () => {
    expect(restampTarget({ ...held, outgoing: { ...held.outgoing, from: [] } }, live)).toBeNull();
    expect(restampTarget({ ...held, outgoing: { ...held.outgoing, from: [{ email: ' ' }] } }, live)).toBeNull();
  });

  it('never re-stamps while the session still serves the entry\'s account (releaseHold covers that)', () => {
    expect(restampTarget(held, { ...live, servesEntryAccount: true })).toBeNull();
  });

  it('never re-stamps without a primary, or onto the account it already names', () => {
    expect(restampTarget(held, { ...live, primaryId: null })).toBeNull();
    expect(restampTarget(held, { ...live, primaryId: 'jOld' })).toBeNull();
  });
});

describe('mayRestamp', () => {
  it('holds only for a queued, account_unavailable, never-attempted entry without attachments', () => {
    expect(mayRestamp(held)).toBe(true);
    expect(mayRestamp({ ...held, attemptStartedAt: 't' })).toBe(false);
    expect(mayRestamp({ ...held, ...withAttachment })).toBe(false);
    expect(mayRestamp({ ...held, heldReason: 'bad_schedule' })).toBe(false);
    expect(mayRestamp({ ...held, state: 'failed' })).toBe(false);
  });
});
