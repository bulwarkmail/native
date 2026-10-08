/**
 * Which timestamp to show for a message. Port of the webmail's
 * `lib/email-date.ts`.
 *
 * JMAP `receivedAt` is the server's internal date - the moment the message
 * landed in the store. An import, migration or backup restore that does not
 * preserve internal dates stamps every message with the import time, so a
 * whole mailbox suddenly "arrived" today (#891). `sentAt` is the RFC 5322
 * `Date` header, which survives such moves and is what Thunderbird, Outlook
 * and Apple Mail display.
 *
 * Prefer `sentAt`; fall back to `receivedAt` when the header is missing,
 * unparsable, or implausibly far in the future relative to the receive time
 * (spam forges future dates to float to the top of date-sorted lists).
 */

import type { TimeFormat } from '../stores/settings-store';
import { formatWorded, type DateRegion } from './date-format';

/** How far ahead of `receivedAt` a `Date` header may be before it is ignored. */
export const MAX_FUTURE_SENT_AT_MS = 24 * 60 * 60 * 1000;

interface DatedEmail {
  sentAt?: string | null;
  receivedAt?: string | null;
}

type DisplayDate<T extends DatedEmail> = T extends { receivedAt: string } ? string : string | undefined;

export function emailDisplayDate<T extends DatedEmail>(email: T): DisplayDate<T> {
  const { sentAt, receivedAt } = email;
  const fallback = (receivedAt ?? undefined) as DisplayDate<T>;
  if (!sentAt) return fallback;
  const sent = Date.parse(sentAt);
  if (Number.isNaN(sent)) return fallback;
  if (receivedAt) {
    const received = Date.parse(receivedAt);
    if (!Number.isNaN(received) && sent - received > MAX_FUTURE_SENT_AT_MS) return fallback;
  }
  return sentAt as DisplayDate<T>;
}

// Worded dates and times in the language's own pattern, in the app's time
// zone. The date format region orders only all-digit dates (formatWorded),
// so `region.dateLocale` does not apply here.
const HEADER_DATE: Intl.DateTimeFormatOptions = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' };

function parse(iso: string | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Mon, 3 Jun 2026" in the app locale. */
export function formatHeaderDate(iso: string | undefined, locale?: string, region: DateRegion = {}): string {
  const d = parse(iso);
  return d ? formatWorded(d, HEADER_DATE, { locale, timeZone: region.timeZone }) : '';
}

/** "14:05" / "2:05 PM" honouring the app's time-format setting. */
export function formatHeaderTime(
  iso: string | undefined,
  timeFormat: TimeFormat,
  locale?: string,
  region: DateRegion = {},
): string {
  const d = parse(iso);
  if (!d) return '';
  const options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: timeFormat === '12h' };
  return formatWorded(d, options, { locale, timeZone: region.timeZone });
}

/** Full date + time for the details panel. */
export function formatFullDateTime(
  iso: string | undefined,
  timeFormat: TimeFormat,
  locale?: string,
  region: DateRegion = {},
): string {
  const d = parse(iso);
  if (!d) return '';
  return formatWorded(
    d,
    { ...HEADER_DATE, hour: '2-digit', minute: '2-digit', hour12: timeFormat === '12h' },
    { locale, timeZone: region.timeZone },
  );
}
