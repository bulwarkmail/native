/**
 * How a run stops early, and what each failure means for the report
 * (docs/device-sync.md, "Headless payload, report and SyncResult" and
 * "Failure matrix").
 */
import type { RunOutcome } from '../types';
import { isMethodError, isRequestLimitError, retryAfterMs, transportFailure } from '../jmap/errors';

/** Out of time, or cancelled: stop cleanly between chunks, ask for another sync. */
export class StopRun extends Error {
  constructor(readonly reason: 'cancelled' | 'deadline') {
    super(reason === 'deadline' ? 'Out of time; the rest follows in the next sync' : 'Cancelled');
    this.name = 'StopRun';
  }
}

/** A run ends with this outcome. `noProgress` zeroes the counts so SyncManager backs off instead of retrying at once. */
export class RunAbort extends Error {
  constructor(
    readonly outcome: RunOutcome,
    message: string,
    readonly options: { noProgress?: boolean; delayUntil?: number } = {},
  ) {
    super(message);
    this.name = 'RunAbort';
  }
}

/** The server changed since the download an upload was planned from. */
export class StateMismatch extends Error {
  constructor(readonly jmapAccountId: string) {
    super(`stateMismatch in ${jmapAccountId}`);
    this.name = 'StateMismatch';
  }
}

export interface ClassifiedFailure {
  outcome: RunOutcome;
  message: string;
  delayUntil?: number;
  moreRecordsToGet?: boolean;
  noProgress?: boolean;
  /** Tell the user to sign in again. */
  authProblem?: boolean;
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

/** A provider refusal for a missing runtime permission (the native module rejects with it). */
export function isPermissionFailure(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return e?.code === 'permission' || (typeof e?.message === 'string' && /\bpermission\b|SecurityException/i.test(e.message));
}

export function classifyFailure(error: unknown, now: number): ClassifiedFailure {
  if (error instanceof StopRun) {
    return { outcome: 'cancelled', message: error.message, moreRecordsToGet: true };
  }
  if (error instanceof RunAbort) {
    return { outcome: error.outcome, message: error.message, noProgress: error.options.noProgress, delayUntil: error.options.delayUntil };
  }
  if (error instanceof StateMismatch) {
    return { outcome: 'io', message: 'The server kept changing during the upload', noProgress: true };
  }
  switch (transportFailure(error)) {
    case 'auth':
      return { outcome: 'auth', message: messageOf(error), authProblem: true };
    case 'network':
    case 'timeout':
      return { outcome: 'io', message: messageOf(error) };
    case 'rateLimit': {
      const wait = retryAfterMs(error) ?? 60_000;
      return { outcome: 'io', message: messageOf(error), delayUntil: Math.ceil((now + wait) / 1000) };
    }
    default:
      break;
  }
  if (isPermissionFailure(error)) return { outcome: 'permission', message: messageOf(error) };
  if (isRequestLimitError(error)) return { outcome: 'internal', message: messageOf(error) };
  if (isMethodError(error)) return { outcome: 'io', message: `${error.type}: ${messageOf(error)}` };
  if (error instanceof Error && /^(JMAP request failed|Invalid JSON response)/.test(error.message)) {
    return { outcome: 'io', message: messageOf(error) };
  }
  return { outcome: 'internal', message: messageOf(error) };
}
