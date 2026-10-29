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
import { intlLocale } from './intl-locale';

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

/** "Mon, 3 Jun 2026" in the app locale. */
export function formatHeaderDate(iso: string | undefined, locale?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(intlLocale(locale), {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
  });
}

/** "14:05" / "2:05 PM" honouring the app's time-format setting. */
export function formatHeaderTime(iso: string | undefined, timeFormat: TimeFormat, locale?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(intlLocale(locale), {
    hour: '2-digit', minute: '2-digit', hour12: timeFormat === '12h',
  });
}

/** Full date + time for the details panel. */
export function formatFullDateTime(iso: string | undefined, timeFormat: TimeFormat, locale?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(intlLocale(locale), {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: timeFormat === '12h',
  });
}
