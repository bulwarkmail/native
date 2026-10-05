// One "not sent" toast per entry that ends up failed or uncertain. Watches the
// store, so replay needs no knowledge of it.
import { useSendQueueStore } from '../stores/send-queue-store';
import { useLocaleStore } from '../stores/locale-store';
import { toast } from '../stores/toast-store';
import { unannouncedUnsent } from './outbox-rows';

export function startOutboxToasts(openOutbox: () => void): () => void {
  const notified = new Set<string>();
  const announce = () => {
    const fresh = unannouncedUnsent(useSendQueueStore.getState().entries, notified);
    if (fresh.length === 0) return;
    const t = useLocaleStore.getState().t;
    // Failed is certain; uncertain must not claim the message was not sent.
    const onlyUncertain = fresh.every((e) => e.state === 'uncertain');
    const title = onlyUncertain
      ? t('outbox.uncertain', 'A message may not have been sent. Check Outbox.')
      : t('outbox.failed', 'A message was not sent');
    toast.error(title, {
      message: t('outbox.failed_hint', 'Check the Outbox to retry, save it as a draft or discard it.'),
      action: { label: t('outbox.open', 'Open Outbox'), onPress: openOutbox },
    });
  };
  announce();
  return useSendQueueStore.subscribe(announce);
}
