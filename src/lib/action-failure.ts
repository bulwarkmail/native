import { toast } from '../stores/toast-store';

// Actions finish after the screen may already have moved on, so a failure is
// reported as a toast instead of vanishing with the promise (webmail
// `lib/email-action-toast.ts`).
export function reportActionFailure(title: string, err: unknown): void {
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
