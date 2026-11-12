import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { useToastStore } from '../../stores/toast-store';
import { showDraftSavedNotice } from '../compose-draft-close-notice';

// Closing the composer keeps the draft and says so: "Draft saved · Open ·
// Discard", Discard with its own Undo (webmail lib/compose/draft-close-toast.ts).

const t = (_key: string, fallback: string) => fallback;
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

describe('draft saved notice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.getState().clearToasts();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('offers Open and Discard', () => {
    const open = vi.fn();
    showDraftSavedNotice({ open, discard: vi.fn() }, t);
    const [shown] = useToastStore.getState().toasts;
    expect(shown.title).toBe('Draft saved');
    expect(shown.secondaryAction?.label).toBe('Open');
    expect(shown.action?.label).toBe('Discard');
    shown.secondaryAction!.onPress();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('deletes the draft once "Draft discarded" goes without an Undo', () => {
    const discard = vi.fn();
    showDraftSavedNotice({ open: vi.fn(), discard }, t);
    useToastStore.getState().toasts[0].action!.onPress();
    const undoToast = useToastStore.getState().toasts.find((x) => x.title === 'Draft discarded')!;
    expect(undoToast.action?.label).toBe('Undo');
    expect(discard).not.toHaveBeenCalled();
    vi.advanceTimersByTime(120_000);
    expect(discard).toHaveBeenCalledTimes(1);
  });

  it('keeps the draft when Undo is pressed', () => {
    const discard = vi.fn();
    showDraftSavedNotice({ open: vi.fn(), discard }, t);
    useToastStore.getState().toasts[0].action!.onPress();
    useToastStore.getState().toasts.find((x) => x.title === 'Draft discarded')!.action!.onPress();
    vi.advanceTimersByTime(120_000);
    expect(discard).not.toHaveBeenCalled();
  });

  // No RN renderer in the suite: the wiring, read from the source.
  it('draws the second button and announces a kept draft on every close that keeps one', () => {
    expect(read('components/ToastHost.tsx')).toMatch(/\{toast\.secondaryAction \? \(\s+<Pressable\s+onPress=\{\(\) => \{ toast\.secondaryAction\?\.onPress\(\); removeToast\(toast\.id\); \}\}/);
    const src = read('screens/ComposeScreen.tsx');
    expect(src).toMatch(/await saveDraft\(\{ live: true \}\);\s+allowLeaveRef\.current = true;\s+announceKeptDraft\(\);\s+proceed\(\);/);
    expect(src).toMatch(/if \(await savedAlready\(\)\) \{\s+allowLeaveRef\.current = true;\s+announceKeptDraft\(\);/);
    expect(src).toMatch(/return navigation\.addListener\('beforeRemove', \(\) => \{\s+if \(!allowLeaveRef\.current\) announceKeptDraft\(\);/);
  });
});
