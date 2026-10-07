import type { MessageParams } from '../i18n';
import type { VacationAudience, VacationForward } from './sieve/types';
import { isValidForwardAddress } from './sieve/vacation-forward';
import { ownDomains } from './sieve/vacation-audience';

// The forwarding and reply-audience part of the vacation card, from the
// webmail's components/settings/vacation-settings.tsx, as pure functions:
// what the card offers, what a save sends, what it warns of, and how a
// failed save is told. Errors are told apart by name, so this module needs
// none of the stores that throw them.

export type AudienceChoice = 'all' | 'internal' | 'external';
export type Translate = (key: string, fallback?: string, params?: MessageParams) => string;
type ForwardSettings = Pick<VacationForward, 'enabled' | 'to' | 'keepCopy'>;

/**
 * "Internal" senders: the domains of the identities, when they were read
 * for the account shown (`shownScope`, null when the client serves another
 * one). Another account's identities give none.
 */
export function audienceDomains(
  identities: { email: string }[],
  identitiesFor: string | null,
  shownScope: string | null,
): string[] {
  if (identitiesFor === null || identitiesFor !== shownScope) return [];
  return ownDomains(identities.map((i) => i.email));
}

export interface FiltersFormInput {
  /** A shared or group account is shown, not the user's own. */
  managed: boolean;
  forwardAvailable: boolean;
  audienceAvailable: boolean;
  /** See audienceDomains. */
  domains: string[];
  storedForward: VacationForward | null;
  storedAudience: VacationAudience | null;
  forwardEnabled: boolean;
  forwardTo: string;
  forwardKeep: boolean;
  audienceOnly: AudienceChoice;
  otherForwards: number;
  /** The server's maxNumberRedirects; unknown or 0 sets no limit here. */
  forwardLimit: number | null | undefined;
  notRunning: boolean;
  filtersStopped: boolean;
  includeAvailable: boolean;
}

export interface FiltersForm {
  showForward: boolean;
  canNarrow: boolean;
  forwardInvalid: boolean;
  forwardOverLimit: boolean;
  /** What to send for forwarding: undefined when unchanged, null to remove it. */
  forward: ForwardSettings | null | undefined;
  /** What to send for the audience: undefined when unchanged, null for everyone. */
  audience: VacationAudience | null | undefined;
  /** A save also touches forwarding or the audience, sent or stored. */
  filtersInvolved: boolean;
  /** A save sets right what is stored but does not run. */
  restartable: boolean;
  /** Save is refused until this is fixed. */
  blocking: boolean;
}

function sameForward(a: ForwardSettings | null, b: VacationForward | null): boolean {
  if (!a || !b) return a === b;
  return a.enabled === b.enabled && a.to === b.to && a.keepCopy === b.keepCopy;
}

export function vacationFiltersForm(i: FiltersFormInput): FiltersForm {
  // Both are hidden on a shared or group account, as in the webmail: the
  // domains come from the user's own identities, and forwarding takes the
  // own account's Sieve capabilities there.
  const showForward = i.forwardAvailable && !i.managed;
  const canNarrow = i.audienceAvailable && !i.managed && i.domains.length > 0;

  // Who gets the auto-reply as a save stores it: everyone, or the senders
  // from (or not from) the account's domains as they are now.
  const audienceSettings = i.audienceOnly === 'all' ? null : { only: i.audienceOnly, domains: i.domains };
  const audienceChanged = canNarrow && (
    i.audienceOnly !== (i.storedAudience?.only ?? 'all') ||
    (i.audienceOnly !== 'all' && i.domains.join(',') !== (i.storedAudience?.domains ?? []).join(','))
  );

  // Forwarding as a save stores it: an address that is off is kept for next
  // time if it is usable, and dropped otherwise.
  const addressUsable = isValidForwardAddress(i.forwardTo);
  const forwardInvalid = showForward && i.forwardEnabled && !addressUsable;
  const forwardSettings = i.forwardEnabled || addressUsable
    ? { enabled: i.forwardEnabled, to: i.forwardTo, keepCopy: i.forwardKeep }
    : null;
  // Only what was changed here is sent: the rest stays as the server has it,
  // which another device may have changed since this one loaded.
  const forwardChanged = showForward && !sameForward(forwardSettings, i.storedForward);
  // Kept here, the message goes on through the filter rules, whose forwards
  // share the server's limit with this one.
  const forwardOverLimit = showForward && i.forwardEnabled && i.forwardKeep &&
    typeof i.forwardLimit === 'number' && i.forwardLimit > 0 && 1 + i.otherForwards > i.forwardLimit;

  const forward = forwardChanged ? forwardSettings : undefined;
  const audience = audienceChanged ? audienceSettings : undefined;
  return {
    showForward,
    canNarrow,
    forwardInvalid,
    forwardOverLimit,
    forward,
    audience,
    filtersInvolved: forward !== undefined || audience !== undefined ||
      !!i.storedForward?.enabled || !!i.storedAudience,
    restartable: (i.notRunning && (showForward || canNarrow)) || (i.filtersStopped && i.includeAvailable),
    blocking: forwardInvalid,
  };
}

/** The card's warnings about forwarding, the audience and the filters, in order. */
export function vacationFiltersWarnings(form: FiltersForm, i: FiltersFormInput, t: Translate): string[] {
  const warnings: string[] = [];
  if (form.forwardInvalid) {
    warnings.push(t('settings.vacation.warnings.forward_address', 'Enter a valid address to forward to'));
  }
  if (form.forwardOverLimit) {
    warnings.push(t('settings.filters.forward_limit', 'Forward limit per message on this server: {count}. Extra forwards are skipped.', { count: i.forwardLimit }));
  }
  if (i.notRunning && (form.showForward || form.canNarrow)) {
    warnings.push(t('settings.vacation.warnings.not_running', 'Forwarding or the reply recipients are saved but not active right now. Save to turn them back on.'));
  }
  if (i.filtersStopped) {
    warnings.push(i.includeAvailable
      ? t('settings.vacation.warnings.filters_stopped_restart', 'Your filters are not running while the auto-reply is on. Save to run them again.')
      : t('settings.vacation.warnings.filters_stopped_paused', 'Your filters are paused while the auto-reply is on: this server cannot run both.'));
  }
  return warnings;
}

// The text for the errors the card knows; null for any other.
function knownErrorMessage(err: unknown, t: Translate): string | null {
  const name = err instanceof Error ? err.name : '';
  switch (name) {
    case 'OpaqueFiltersError':
      return t('settings.vacation.errors.filters_opaque', 'Your filters were edited by hand, so they cannot be kept running next to the auto-reply. Turn the auto-reply off, or change the filters in the Sieve editor.');
    case 'SieveCapabilitiesUnknownError':
      return t('settings.vacation.errors.capabilities_unknown', 'The server has not said yet what your filters can do. Try again in a moment.');
    case 'StaleLoadError':
      return t('settings.vacation.errors.account_changed', 'The account changed before this finished. Try again.');
    // Already in the user's language (see AccountNotServedError).
    case 'AccountNotServedError':
      return (err as Error).message;
    default:
      return null;
  }
}

/** Why a load or save failed, in the user's language; never the raw error text. */
export function vacationErrorMessage(err: unknown, t: Translate): string {
  return knownErrorMessage(err, t) ?? t('settings.vacation.errors.generic', 'Something went wrong. Please try again.');
}

/**
 * The alert for a failed save. A VacationFiltersError comes after the
 * response was saved, so its title says so, and what was not: forwarding
 * and the audience when the save involved them, else the filters, which may
 * now be stopped next to the auto-reply.
 */
export function vacationSaveFailure(
  err: unknown,
  filtersInvolved: boolean,
  t: Translate,
): { title: string; message?: string } {
  if (err instanceof Error && err.name === 'VacationFiltersError') {
    const reason = knownErrorMessage((err as Error & { reason?: unknown }).reason, t);
    return {
      title: filtersInvolved
        ? t('notifications.vacation_filters_save_failed', 'Out of office settings saved, but the forwarding and reply recipients could not be saved')
        : t('notifications.vacation_filters_restart_failed', 'Out of office settings saved, but your filters could not be restarted'),
      ...(reason !== null ? { message: reason } : {}),
    };
  }
  return {
    title: t('notifications.vacation_save_failed', 'Failed to save out of office settings'),
    message: vacationErrorMessage(err, t),
  };
}
