// After the composer closed and kept its draft: "Draft saved", with Open and
// Discard; Discard has its own Undo (webmail lib/compose/draft-close-toast.ts,
// 656073804). Without it there was no quick way back to the draft or to drop
// it.

import { toast, useToastStore } from '../stores/toast-store';

/** How long "Draft discarded" waits for an Undo when the toast stays until closed. */
export const DISCARD_UNDO_MS = 5000;

type Translate = (key: string, fallback: string) => string;

/**
 * "Draft discarded" with Undo. `discard` runs once the toast is gone without
 * an Undo, so Undo needs nothing from the server: the draft is still there.
 */
export function discardWithUndo(discard: () => void, t: Translate): void {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const id = toast.success(t('compose_ux.draft_discarded', 'Draft discarded'), {
    action: {
      label: t('compose_ux.undo', 'Undo'),
      onPress: () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
      },
    },
  });
  const shown = useToastStore.getState().toasts.find((x) => x.id === id)?.duration;
  timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    discard();
  }, shown && shown > 0 ? shown : DISCARD_UNDO_MS);
}

/** "Draft saved · Open · Discard" once a composer closed and kept its draft. */
export function showDraftSavedNotice(
  actions: { open: () => void; discard: () => void },
  t: Translate,
): void {
  toast.success(t('email_composer.draft_saved', 'Draft saved'), {
    action: { label: t('email_composer.discard', 'Discard'), onPress: () => discardWithUndo(actions.discard, t) },
    secondaryAction: { label: t('compose_dock.open_draft', 'Open'), onPress: actions.open },
  });
}
