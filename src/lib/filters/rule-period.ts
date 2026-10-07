import type { FilterRule } from '../sieve/types';
import { hasPeriod, isPeriodBoundary, periodStatus } from '../sieve/period';
import { retroactiveSupport, type RetroSupport } from './retroactive';

// The rule editor's period fields (webmail filter-rule-modal): "only active
// from ... until ...". The fields hold the boundaries as ISO UTC strings, so
// a boundary the user leaves alone is saved exactly as it came, seconds and
// zone included.

type Translate = (key: string, fallback?: string) => string;
type Period = Pick<FilterRule, 'activeFrom' | 'activeUntil'>;

export interface PeriodDraft {
  /** "Only active during a period" is ticked. */
  on: boolean;
  /** Undefined for an open start. */
  from?: string;
  /** Undefined for an open end. */
  until?: string;
}

export function periodDraftOf(rule: Period | undefined): PeriodDraft {
  return { on: !!rule && hasPeriod(rule), from: rule?.activeFrom, until: rule?.activeUntil };
}

export type PeriodError = 'invalid' | 'empty' | 'order';

/**
 * The period to save, or why Save must be refused. A boundary the generator
 * cannot write would drop the whole rule from the script, so it is refused
 * here rather than saved.
 */
export function resolvePeriod(
  draft: PeriodDraft,
): ({ ok: true } & Period) | { ok: false; error: PeriodError } {
  if (!draft.on) return { ok: true, activeFrom: undefined, activeUntil: undefined };
  const { from, until } = draft;
  if ((from !== undefined && !isPeriodBoundary(from)) || (until !== undefined && !isPeriodBoundary(until))) {
    return { ok: false, error: 'invalid' };
  }
  if (from === undefined && until === undefined) return { ok: false, error: 'empty' };
  if (from !== undefined && until !== undefined && Date.parse(until) <= Date.parse(from)) {
    return { ok: false, error: 'order' };
  }
  return { ok: true, activeFrom: from, activeUntil: until };
}

/**
 * `rule` with both period fields set, to undefined when there is none: the
 * settings page merges the saved rule into the stored one, where a field left
 * out would keep its old value.
 */
export function withPeriod<T extends object>(
  rule: T,
  period: Period,
): T & { activeFrom: string | undefined; activeUntil: string | undefined } {
  return { ...rule, activeFrom: period.activeFrom, activeUntil: period.activeUntil };
}

/**
 * Whether the edited rule can also run over the mail already there. A rule
 * with a period acts on mail as it arrives within it, which says nothing about
 * the mail already there - so not while the period is on, even before its
 * fields are filled in.
 */
export function editorRetroSupport(
  rule: Pick<FilterRule, 'conditions' | 'actions'>,
  draft: PeriodDraft,
): RetroSupport {
  if (draft.on) return { ok: false, reason: 'period' };
  return retroactiveSupport({ conditions: rule.conditions, actions: rule.actions });
}

/** The moment a picker opens on: the boundary, or `fallback` to the whole minute. */
export function pickerDate(boundary: string | undefined, fallback: number = Date.now()): Date {
  if (isPeriodBoundary(boundary)) return new Date(Date.parse(boundary));
  return new Date(Math.floor(fallback / 60_000) * 60_000);
}

/**
 * A picked moment as the boundary to store: ISO UTC, or `saved` itself when
 * the same moment was picked. Null for a date that holds no moment. A moment
 * past year 9999 comes back as an expanded-year string that resolvePeriod
 * refuses.
 */
export function pickedBoundary(picked: Date, saved?: string): string | null {
  const time = picked.getTime();
  if (Number.isNaN(time)) return null;
  if (isPeriodBoundary(saved) && Date.parse(saved) === time) return saved;
  return picked.toISOString();
}

/** `base` on the day picked (Android's date step), its time kept. */
export function withPickedDate(base: Date, picked: Date): Date {
  const next = new Date(base);
  next.setFullYear(picked.getFullYear(), picked.getMonth(), picked.getDate());
  return next;
}

/** `base` at the time picked (Android's time step), to the whole minute. */
export function withPickedTime(base: Date, picked: Date): Date {
  const next = new Date(base);
  next.setHours(picked.getHours(), picked.getMinutes(), 0, 0);
  return next;
}

/** "5 Oct 2026, 08:00" in the device zone; an ellipsis for an open end. */
export function formatPeriodBoundary(boundary: string | undefined, timeFormat: '12h' | '24h', locale?: string): string {
  if (!isPeriodBoundary(boundary)) return '…';
  const date = new Date(Date.parse(boundary));
  const options: Intl.DateTimeFormatOptions = {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: timeFormat === '12h',
  };
  try {
    return date.toLocaleString(!locale || locale === 'en' ? 'en-US' : locale, options);
  } catch {
    return date.toLocaleString();
  }
}

/**
 * The rule's period ("5 Oct 2026, 08:00 – …") and, for a rule that is on,
 * where now falls in it; null without a period.
 */
export function periodLabel(
  rule: FilterRule,
  options: { t: Translate; timeFormat: '12h' | '24h'; locale?: string; now?: number },
): { range: string; status: string | null } | null {
  const { t, timeFormat, locale, now } = options;
  const status = periodStatus(rule, now);
  if (!status) return null;
  const format = (boundary: string | undefined) => formatPeriodBoundary(boundary, timeFormat, locale);
  return {
    range: `${format(rule.activeFrom)} – ${format(rule.activeUntil)}`,
    // A rule that is off does nothing in any period; "active" next to it
    // would say otherwise.
    status: rule.enabled ? t(`settings.filters.period_status_${status}`, status) : null,
  };
}
