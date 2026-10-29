import { create } from 'zustand';
import type { PairingError, QrLoginPayload } from '../lib/oauth';

// A tapped `bulwarkmail://` sign-in link arrives before the login screen is
// up (cold start, or signed in with Add account not open yet). It is parked
// here and taken by LoginScreen, which runs it like a scanned code. Taking
// clears it, so one link signs in once however often it is delivered.
//
// Where a link came from decides whether the user is asked first:
// - `external`: the OS handed it to the app. Any web page (one tap) or any
//   installed app (no tap at all) can fire one, with a webmail and a code of
//   its own choosing, so the user confirms before it is redeemed or opened.
// - `in-app`: scanned with the app's scanner or pasted into its paste box.
//   The user just did that in the app, so it runs straight away.
export type SignInLinkSource = 'external' | 'in-app';

export interface PendingSignInLink {
  // Tells one delivery from the next, so a dialog can only ever confirm the
  // link it named.
  id: number;
  payload: QrLoginPayload;
  source: SignInLinkSource;
}

export interface TakenSignInLink {
  id: number;
  payload: QrLoginPayload;
  // Show the confirmation and run the link only on Continue (`confirm`).
  needsConfirmation: boolean;
}

export function signInLinkNeedsConfirmation(source: SignInLinkSource): boolean {
  return source !== 'in-app';
}

interface PendingSignInLinkState {
  // Parked, not taken by a login screen yet.
  pending: PendingSignInLink | null;
  // Taken and shown to the user, waiting for Continue or Cancel.
  awaitingConfirmation: PendingSignInLink | null;
  // A tapped link that is refused outright (a pairing code for a plain-http
  // webmail): nothing to run or confirm, the login screen says why.
  refusal: PairingError | null;
  /** Park a link. Returns false when it was dropped (a dialog is open). */
  park: (payload: QrLoginPayload, source: SignInLinkSource) => boolean;
  /**
   * Take the parked link. One that needs confirmation moves to
   * `awaitingConfirmation`; run it only with what `confirm` returns.
   */
  take: () => TakenSignInLink | null;
  /** Continue: the payload to run, or null when that link is gone. */
  confirm: (id: number) => QrLoginPayload | null;
  /**
   * Cancel: forget the link, so nothing redeems it later. Returns whether it
   * was still waiting.
   */
  discard: (id: number) => boolean;
  refuse: (refusal: PairingError) => void;
  takeRefusal: () => PairingError | null;
  /** Drop what is parked (not a link a dialog is asking about). */
  dropParked: () => boolean;
  clear: () => void;
}

let nextId = 1;

export const usePendingSignInLinkStore = create<PendingSignInLinkState>((set, get) => ({
  pending: null,
  awaitingConfirmation: null,
  refusal: null,
  park: (payload, source) => {
    // While the user is asked about one link, another is dropped rather
    // than queued behind it or swapped in: Continue must run the link the
    // dialog names and nothing else, and a link fired while the dialog is
    // open must not pop up right after Cancel.
    if (get().awaitingConfirmation) return false;
    set({ pending: { id: nextId++, payload, source } });
    return true;
  },
  take: () => {
    const { pending, awaitingConfirmation } = get();
    if (!pending || awaitingConfirmation) return null;
    const needsConfirmation = signInLinkNeedsConfirmation(pending.source);
    set({ pending: null, awaitingConfirmation: needsConfirmation ? pending : null });
    return { id: pending.id, payload: pending.payload, needsConfirmation };
  },
  confirm: (id) => {
    const link = get().awaitingConfirmation;
    if (!link || link.id !== id) return null;
    set({ awaitingConfirmation: null });
    return link.payload;
  },
  discard: (id) => {
    if (get().awaitingConfirmation?.id !== id) return false;
    set({ awaitingConfirmation: null });
    return true;
  },
  refuse: (refusal) => set({ refusal }),
  takeRefusal: () => {
    const refusal = get().refusal;
    if (refusal) set({ refusal: null });
    return refusal;
  },
  dropParked: () => {
    const { pending, refusal } = get();
    if (!pending && !refusal) return false;
    set({ pending: null, refusal: null });
    return true;
  },
  clear: () => set({ pending: null, awaitingConfirmation: null, refusal: null }),
}));

export function setPendingSignInLink(payload: QrLoginPayload, source: SignInLinkSource): boolean {
  return usePendingSignInLinkStore.getState().park(payload, source);
}
