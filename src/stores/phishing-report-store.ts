import { create } from 'zustand';
import type { Email } from '../api/types';

/**
 * Messages reported as phishing in this session (#124), the webmail's
 * usePhishingReportStore.reported: every view of them turns its links off
 * at once, before the server's `$phishing` reaches it, and a message whose
 * report went out but couldn't be moved to Junk still counts as reported
 * (no second report to the admin). Keyed by reportedKey.
 */
interface PhishingReportState {
  reported: Record<string, true>;
  markReported: (keys: string[], reported: boolean) => void;
}

/** A message's key: its JMAP account (undefined = the user's own) and id. */
export function reportedKey(id: string, accountId?: string): string {
  return `${accountId ?? ''}:${id}`;
}

export const usePhishingReportStore = create<PhishingReportState>()((set) => ({
  reported: {},
  markReported: (keys, reported) => set((state) => {
    const next = { ...state.reported };
    for (const key of keys) {
      if (reported) next[key] = true;
      else delete next[key];
    }
    return { reported: next };
  }),
}));

/** Whether a message shows as reported: its `$phishing`, or reported in this session. */
export function usePhishingMarked(email: Pick<Email, 'id' | 'keywords'> | null | undefined, accountId?: string): boolean {
  const reported = usePhishingReportStore((s) => (email ? s.reported[reportedKey(email.id, accountId)] === true : false));
  return email?.keywords?.$phishing === true || reported;
}
