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
 * The JMAP error type a thrown value carries: a method error, or a SetError
 * thrown as a `JMAPMethodError`. Callers branch on it instead of the
 * description, which differs between servers and Stalwart releases.
 */
export function jmapErrorType(err: unknown): string | undefined {
  return err instanceof JMAPMethodError ? err.type : undefined;
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
 * A SetError (RFC 8620 §5.3): the server looked at one object of a /set call
 * and refused it (`notCreated` / `notUpdated` / `notDestroyed`), as opposed
 * to refusing the whole method call. The same type can come either way
 * (`forbidden` is both), and only a SetError says something about that
 * object. It is a `JMAPMethodError` with that name, so `instanceof` checks
 * and the name-based classification in lib/network-error treat it as before.
 */
export class JMAPSetError extends JMAPMethodError {
  /** The properties the server named (`invalidProperties`), if any. */
  properties?: string[];
  /**
   * The objects a /set of several left unchanged, when the thrower knows them:
   * the server refuses objects one by one and applies the rest.
   */
  failedIds?: string[];
  constructor(type: string, description?: string, properties?: string[]) {
    super(type, description);
    if (properties?.length) this.properties = properties;
  }
}

/**
 * The objects a write of several left unchanged, when the error names them
 * (JMAPSetError.failedIds); null when it doesn't say - a failed request, a
 * refused method call - so any of them may be unchanged.
 */
export function failedIdsOf(error: unknown): string[] | null {
  return error instanceof JMAPSetError && error.failedIds ? error.failedIds : null;
}

/** Whether a thrown value is a SetError rather than a refused method call. */
export function isJMAPSetError(err: unknown): err is JMAPSetError {
  return err instanceof JMAPSetError;
}

/**
 * Throw a `JMAPSetError` when a /set response reports the given ids (or any
 * id when `ids` is omitted) under `notCreated` / `notUpdated` /
 * `notDestroyed`.
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
    const error = new JMAPSetError(
      err?.type ?? 'setError',
      `Failed to ${verb} ${what} ${id}${more}: ${detail.join(' – ')}`,
      err?.properties,
    );
    error.failedIds = entries.map(([failed]) => failed);
    throw error;
  }
}

/**
 * The server refused a new EmailSubmission because the account holds too many
 * submission records, and removing the ones that can no longer be cancelled
 * did not make room. Stalwart 1.0 counts every record, whatever its status or
 * age, against `maxSubmissions` (500 by default) and answers the create with
 * `overQuota` - not to be confused with Email/set's `overQuota`, which means
 * the mailbox storage is full.
 */
export class SubmissionQuotaError extends JMAPMethodError {
  constructor(
    /** The server's own description, if it gave one. */
    readonly description?: string,
    /**
     * The submission account is on Stalwart (`urn:stalwart:jmap`), whose
     * limit is the count of submission records. Another server's overQuota
     * may stand for any sending limit.
     */
    readonly countsRecords = false,
  ) {
    super('overQuota', description || 'There are too many email submissions');
    this.name = 'SubmissionQuotaError';
  }
}

/**
 * "Send now" or a reschedule found the original submission no longer pending
 * after making room for its replacement, which can take a while: it went out
 * (`sent`), or was cancelled or removed elsewhere. No replacement was made.
 */
export class NoLongerScheduledError extends Error {
  constructor(readonly sent: boolean) {
    super(sent ? 'The scheduled message was already sent' : 'The message is no longer scheduled');
    this.name = 'NoLongerScheduledError';
  }
}

/** A recipient the server refused to take a message for (EmailSubmission deliveryStatus `delivered: "no"`). */
export interface RefusedRecipient {
  email: string;
  /** The server's SMTP reply, e.g. "550 5.1.2 Relay not allowed." */
  smtpReply?: string;
}

/** "nobody@example.net (550 5.1.2 Relay not allowed.)", one per refused recipient. */
export function formatRefusedRecipients(recipients: RefusedRecipient[]): string {
  return recipients.map((r) => (r.smtpReply ? `${r.email} (${r.smtpReply})` : r.email)).join(', ');
}

/**
 * The server took a submission but refused every one of its recipients, so
 * nothing was queued: nothing goes out, and no bounce will say so. Stalwart
 * answers this way to a relay it doesn't allow ("550 5.1.2 Relay not
 * allowed.") and to a throttle that is used up ("452 4.4.5 Rate limit
 * exceeded, try again later."), on 0.16 and 1.0 alike.
 */
export class RecipientsRefusedError extends Error {
  constructor(readonly recipients: RefusedRecipient[]) {
    super(`The server refused ${formatRefusedRecipients(recipients)}`);
    this.name = 'RecipientsRefusedError';
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
 * The properties a thrown SetError names, so a caller can tell
 * `invalidProperties` on `media` from one on `name`; empty for anything else.
 */
export function jmapErrorProperties(err: unknown): string[] {
  return err instanceof JMAPSetError ? err.properties ?? [] : [];
}
