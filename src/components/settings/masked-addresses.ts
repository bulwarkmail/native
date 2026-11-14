// What the Masked addresses section shows for an answer of the server
// (webmail components/settings/masked-addresses-section.tsx).

import { maskedEmailErrorType, maskedEmailUnavailable, type MaskedAddress } from '../../lib/masked-email';

export const MASKED_PAGE_SIZE = 10;

export type MaskedLoadFailure = 'unavailable' | 'forbidden' | 'error';

/** Why the list could not be read: not offered here, not permitted, or failed. */
export function maskedLoadFailure(error: unknown): MaskedLoadFailure {
  if (maskedEmailUnavailable(error)) return 'unavailable';
  return maskedEmailErrorType(error) === 'forbidden' ? 'forbidden' : 'error';
}

export type MaskedChange = 'create' | 'update' | 'destroy';

export type MaskedNotice =
  | 'saved' | 'deleted' | 'deleted_refresh_failed'
  | 'create_forbidden' | 'update_forbidden' | 'delete_forbidden'
  | 'over_quota' | 'rate_limit' | 'save_failed'
  | 'delete_unconfirmed' | 'delete_failed';

/** The line shown after a change the server did not make, or did not confirm. */
export function maskedFailureNotice(change: MaskedChange, error: unknown): MaskedNotice {
  const type = maskedEmailErrorType(error);
  if (change === 'destroy') {
    if (type === 'forbidden') return 'delete_forbidden';
    return type === 'deleteUnconfirmed' ? 'delete_unconfirmed' : 'delete_failed';
  }
  if (type === 'forbidden') return change === 'create' ? 'create_forbidden' : 'update_forbidden';
  if (type === 'overQuota') return 'over_quota';
  return type === 'rateLimit' ? 'rate_limit' : 'save_failed';
}

/** The rows of `page`, clamped to the last page there is. */
export function maskedPage(addresses: MaskedAddress[], page: number): { rows: MaskedAddress[]; page: number; pageCount: number } {
  const pageCount = Math.max(1, Math.ceil(addresses.length / MASKED_PAGE_SIZE));
  const shown = Math.min(Math.max(0, page), pageCount - 1);
  return { rows: addresses.slice(shown * MASKED_PAGE_SIZE, (shown + 1) * MASKED_PAGE_SIZE), page: shown, pageCount };
}
