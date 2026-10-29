import { toast } from '../stores/toast-store';
import { useLocaleStore } from '../stores/locale-store';

/**
 * Runs a store action the screen doesn't wait for (a swipe, a bulk button)
 * and says when it fails. These used to be `void action()`: a change the
 * server refused (not a dropped connection, which the outbox queues) went
 * unnoticed.
 */
export function reportFailure(action: Promise<unknown>): void {
  action.catch((err: unknown) => {
    toast.error(
      useLocaleStore.getState().t('notifications.error_updating', 'Failed to update email'),
      err instanceof Error ? err.message : undefined,
    );
  });
}
