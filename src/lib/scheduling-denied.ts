import { SchedulingDeniedError } from '../api/jmap-result';

export type SchedulingSaveOutcome = 'saved' | 'saved_without_invitations' | 'cancelled';

/**
 * Save an event; when the server refuses to send its invitations, ask whether
 * to save it anyway without them and retry with identical data (webmail does
 * the same). Other errors, and a refusal when no invitations were being sent,
 * propagate.
 */
export async function saveWithSchedulingFallback(
  save: (send: boolean | undefined) => Promise<void>,
  send: boolean | undefined,
  confirm: (reason: string) => Promise<boolean>,
): Promise<SchedulingSaveOutcome> {
  try {
    await save(send);
    return 'saved';
  } catch (err) {
    if (!(send === true && err instanceof SchedulingDeniedError)) throw err;
    if (!(await confirm(err.reason))) return 'cancelled';
  }
  await save(false);
  return 'saved_without_invitations';
}
