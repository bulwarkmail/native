// Deleting things in Settings that can be put back as they were: they go at
// once, with an Undo in the toast, instead of behind a confirm (webmail R3:
// filter-settings.tsx handleDelete, keyword-settings.tsx handleDelete,
// trusted-senders-modal.tsx handleRemoveSender).

import { toast } from '../stores/toast-store';
import { useFilterStore } from '../stores/filter-store';
import { useKeywordsStore } from '../stores/keywords-store';

type Translate = (key: string, fallback?: string, params?: Record<string, string | number>) => string;

/** How long a toast offering Undo stays (webmail lib/email-action-toast.ts). */
export const UNDO_TOAST_DURATION = 8000;

/** Deletes a filter rule on the server at once; the toast's Undo saves it back. */
export async function deleteFilterRuleWithUndo(ruleId: string, t: Translate): Promise<void> {
  const failed = () => toast.error(t('notifications.filters_save_failed', 'Failed to save filters'));
  let undo: (() => Promise<boolean>) | null;
  try {
    undo = await useFilterStore.getState().deleteRuleNow(ruleId);
  } catch {
    failed();
    return;
  }
  if (!undo) return;
  const putBack = undo;
  toast.success(t('notifications.filters_deleted', 'Filter rule deleted'), {
    action: {
      label: t('notifications.rule_undo', 'Undo'),
      onPress: () => { void putBack().catch(failed); },
    },
  });
}

/** Deletes a tag at once; the toast's Undo puts it back where it was. */
export function deleteKeywordWithUndo(id: string, t: Translate): void {
  const before = useKeywordsStore.getState().keywords;
  const index = before.findIndex((k) => k.id === id);
  if (index < 0) return;
  const removed = before[index];
  useKeywordsStore.getState().remove(id);
  toast.success(t('settings.keywords.deleted', 'Tag deleted'), {
    action: {
      label: t('notifications.rule_undo', 'Undo'),
      onPress: () => {
        // Added again meanwhile (same id): nothing to put back.
        if (useKeywordsStore.getState().keywords.some((k) => k.id === id)) return;
        useKeywordsStore.getState().insert(removed, index);
      },
    },
  });
}

export interface TrustedSenderRemoval {
  email: string;
  /** On the list kept in the settings. */
  local: boolean;
  /** In the synced "Trusted Senders" address book. */
  synced: boolean;
}

export interface TrustedSenderStores {
  removeLocal: (email: string) => void;
  addLocal: (email: string) => void;
  removeFromBook: (email: string) => Promise<void>;
  addToBook: (email: string) => Promise<void>;
}

/**
 * Takes a sender off the trusted list (the settings list and the synced
 * address book, wherever it is); the toast's Undo adds it back to the same
 * places. Nothing changes when the address book can't be written.
 */
export async function removeTrustedSenderWithUndo(
  row: TrustedSenderRemoval,
  stores: TrustedSenderStores,
  t: Translate,
): Promise<void> {
  try {
    if (row.synced) await stores.removeFromBook(row.email);
  } catch {
    toast.error(t('settings.email_behavior.trusted_senders.remove_error', "Couldn't remove the sender"));
    return;
  }
  if (row.local) stores.removeLocal(row.email);
  toast.success(t('settings.email_behavior.trusted_senders.removed', 'Removed from trusted senders'), {
    message: row.email,
    duration: UNDO_TOAST_DURATION,
    action: {
      label: t('notifications.undo', 'Undo'),
      onPress: () => {
        if (row.local) stores.addLocal(row.email);
        if (row.synced) {
          void stores.addToBook(row.email).catch(() => {
            toast.error(t('settings.email_behavior.trusted_senders.save_error', 'Failed to save - check the Contacts debug log for details'));
          });
        }
      },
    },
  });
}
