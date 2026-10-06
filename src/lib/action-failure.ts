import { toast } from '../stores/toast-store';
import { isStaleLoad } from './network-error';

// Actions finish after the screen may already have moved on, so a failure is
// reported as a toast instead of vanishing with the promise (webmail
// `lib/email-action-toast.ts`).
export function reportActionFailure(title: string, err: unknown): void {
  // Dropped unsent because the client moved to another account first: the
  // user switched away, so there is nothing to tell them.
  if (isStaleLoad(err)) {
    console.info('[action] dropped after an account switch:', title);
    return;
  }
  console.warn('[action]', title, err);
  toast.error(title, err instanceof Error ? err.message : undefined);
}

// Resolves `undefined` after reporting a rejection and never rejects, so it is
// safe behind `void`. A queued action resolves normally and shows nothing.
export async function withFailureToast<T>(p: Promise<T>, title: string): Promise<T | undefined> {
  try {
    return await p;
  } catch (err) {
    reportActionFailure(title, err);
    return undefined;
  }
}
