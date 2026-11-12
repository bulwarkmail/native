// The calendar's time pattern, kept apart from calendar-utils so the pure
// device sync code (contact-utils) can format a time without pulling in
// the settings store through calendar-timezone. Mirrors the webmail
// (event-card.tsx: `timeFormat === "12h" ? "h:mm a" : "HH:mm"`).
export type TimeFormat = '12h' | '24h';

export function timePattern(timeFormat: TimeFormat | undefined): string {
  return timeFormat === '12h' ? 'h:mm a' : 'HH:mm';
}
