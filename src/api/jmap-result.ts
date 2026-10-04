// Shared JMAP response helpers. Kept dependency-free (no client import) so
// every `src/api/*.ts` module - and their tests, which mock `./jmap-client`
// wholesale - can use them.
//
// Most RN api functions used to index `methodResponses[0][1]` blindly, so a
// method-level `['error', {...}]` reply produced a TypeError on reads and was
// silently treated as success on writes (the outbox then dropped the op).
// Route every response through these instead.

import type { JMAPResponseBody } from './types';

type MethodResponse = [string, Record<string, any>, string];

export class JMAPMethodError extends Error {
  type: string;
  constructor(type: string, description?: string) {
    super(description || type || 'JMAP method error');
    this.name = 'JMAPMethodError';
    this.type = type;
  }
}

/**
 * Pull the response body for `callId` (or the first response when omitted)
 * and throw a `JMAPMethodError` when the server answered with the error
 * envelope. Also verifies the method name when `expectMethod` is given.
 */
export function requireMethodResult<T = Record<string, any>>(
  res: JMAPResponseBody,
  callId?: string,
  expectMethod?: string,
): T {
  const responses = (res?.methodResponses ?? []) as MethodResponse[];
  const match = callId === undefined
    ? responses[0]
    : responses.find((r) => r[2] === callId);
  if (!match) {
    throw new JMAPMethodError(
      'missingResponse',
      `Missing JMAP response${callId !== undefined ? ` for call ${callId}` : ''}`,
    );
  }
  if (match[0] === 'error') {
    const err = match[1] as { type?: string; description?: string };
    throw new JMAPMethodError(err.type ?? 'serverFail', err.description);
  }
  if (expectMethod && match[0] !== expectMethod) {
    throw new JMAPMethodError('unexpectedMethod', `Expected ${expectMethod}, got ${match[0]}`);
  }
  return match[1] as T;
}

/**
 * Throw when a /set response reports the given ids (or any id when `ids` is
 * omitted) under `notCreated` / `notUpdated` / `notDestroyed`.
 */
export function assertSetResult(
  body: Record<string, any>,
  ids?: string[],
  what = 'object',
): void {
  const buckets = ['notCreated', 'notUpdated', 'notDestroyed'] as const;
  for (const bucket of buckets) {
    const failures = body?.[bucket] as
      | Record<string, { type?: string; description?: string; properties?: string[] }>
      | undefined;
    if (!failures) continue;
    const entries = Object.entries(failures).filter(([id]) => !ids || ids.includes(id));
    if (entries.length === 0) continue;
    const [id, err] = entries[0];
    const verb = bucket === 'notCreated' ? 'create' : bucket === 'notUpdated' ? 'update' : 'destroy';
    const detail = [err?.type ?? 'unknown'];
    if (err?.properties?.length) detail.push(`properties=[${err.properties.join(', ')}]`);
    if (err?.description) detail.push(err.description);
    const more = entries.length > 1 ? ` (+${entries.length - 1} more)` : '';
    throw new JMAPMethodError(
      err?.type ?? 'setError',
      `Failed to ${verb} ${what} ${id}${more}: ${detail.join(' – ')}`,
    );
  }
}

/** A scheduled send later than the server's hold limit. */
export class ScheduleTooLateError extends Error {
  maxSeconds?: number;
  constructor(maxSeconds?: number) {
    super('Scheduled send time is later than the server allows');
    this.name = 'ScheduleTooLateError';
    this.maxSeconds = maxSeconds;
  }
}

interface DeliveryStatus {
  delivered?: string;
  smtpReply?: string;
}

export interface RejectedRecipient {
  email: string;
  smtpReply: string;
}

/**
 * The recipients a submission's deliveryStatus (RFC 8621 §7) marks as not
 * delivered, and whether that is all of them - then the message went nowhere.
 */
export function rejectedRecipients(deliveryStatus: Record<string, DeliveryStatus> | null | undefined): {
  rejected: RejectedRecipient[];
  all: boolean;
} {
  const entries = Object.entries(deliveryStatus ?? {});
  const rejected = entries
    .filter(([, status]) => status?.delivered === 'no')
    .map(([email, status]) => ({ email, smtpReply: status.smtpReply?.trim() ?? '' }));
  return { rejected, all: rejected.length > 0 && rejected.length === entries.length };
}

/** "a@example.com (550 5.1.2 Mailbox does not exist.), b@example.com" */
export function formatRejectedRecipients(recipients: RejectedRecipient[]): string {
  return recipients.map(({ email, smtpReply }) => (smtpReply ? `${email} (${smtpReply})` : email)).join(', ');
}

/** The server refused every recipient of a send, so nothing went out. */
export class RecipientsRejectedError extends Error {
  constructor(readonly recipients: RejectedRecipient[]) {
    super(`The server rejected every recipient: ${formatRejectedRecipients(recipients)}`);
    this.name = 'RecipientsRejectedError';
  }
}

/**
 * The send request came back without an EmailSubmission: nothing confirms the
 * message left, and it may still have. The draft is kept.
 */
export class SendUnconfirmedError extends Error {
  constructor() {
    super('Send confirmation was not received. Check Sent before sending again. Your draft has been kept.');
    this.name = 'SendUnconfirmedError';
  }
}

/**
 * The hold limit named in a rejected submission, if that was the reason:
 * Stalwart's MTA refuses a HOLDFOR beyond its `futureRelease` limit with
 * "501 5.5.4 Requested hold time exceeds maximum of N seconds".
 */
export function parseHoldLimit(description: string | undefined): number | null {
  const m = description?.match(/hold time exceeds maximum of (\d+) seconds/i);
  return m ? Number(m[1]) : null;
}

/** Split `items` into consecutive batches of at most `size` entries. */
export function batched<T>(items: T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += step) {
    result.push(items.slice(i, i + step));
  }
  return result;
}

/**
 * The server refused to send an event's invitations (Stalwart 0.16.21+ answers
 * `forbidden` when scheduling is denied). The event itself was not saved.
 */
export class SchedulingDeniedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'SchedulingDeniedError';
  }
}
