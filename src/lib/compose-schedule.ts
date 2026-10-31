// "Schedule send" presets and the release time of a scheduled message.
// Ports of the webmail's lib/schedule-presets.ts and
// lib/scheduled-send-label.ts.

import { intlLocale } from './intl-locale';

export type SchedulePresetKey = 'this_morning' | 'this_afternoon' | 'tomorrow_morning' | 'tomorrow_afternoon' | 'monday_morning';

export interface SchedulePreset {
  key: SchedulePresetKey;
  date: Date;
}

function at(base: Date, daysAhead: number, hour: number): Date {
  const date = new Date(base);
  date.setDate(date.getDate() + daysAhead);
  date.setHours(hour, 0, 0, 0);
  return date;
}

/** How far ahead a time for today must be to be offered, so it is not past by the tap. */
const TODAY_LEAD_MS = 5 * 60_000;

/**
 * One-tap times for "Schedule send": tomorrow at 8:00 and 13:00, and next
 * Monday at 8:00. Monday is left out when it is tomorrow anyway (on a
 * Sunday). Today's 8:00 and 13:00 come first while they are still ahead, so
 * a message written after midnight can go out the same morning (#1390).
 */
export function schedulePresets(now: Date = new Date()): SchedulePreset[] {
  const presets: SchedulePreset[] = [
    { key: 'this_morning' as const, date: at(now, 0, 8) },
    { key: 'this_afternoon' as const, date: at(now, 0, 13) },
  ].filter((preset) => preset.date.getTime() - now.getTime() >= TODAY_LEAD_MS);
  presets.push(
    { key: 'tomorrow_morning', date: at(now, 1, 8) },
    { key: 'tomorrow_afternoon', date: at(now, 1, 13) },
  );
  const daysToMonday = ((8 - now.getDay()) % 7) || 7;
  if (daysToMonday > 1) presets.push({ key: 'monday_morning', date: at(now, daysToMonday, 8) });
  return presets;
}

/** The label of a "Schedule send" preset (webmail email_composer.schedule_preset). */
export function schedulePresetLabel(
  key: SchedulePresetKey,
  t: (key: string, fallback?: string) => string,
): string {
  switch (key) {
    case 'this_morning': return t('email_composer.schedule_preset.this_morning', 'This morning');
    case 'this_afternoon': return t('email_composer.schedule_preset.this_afternoon', 'This afternoon');
    case 'tomorrow_morning': return t('email_composer.schedule_preset.tomorrow_morning', 'Tomorrow morning');
    case 'tomorrow_afternoon': return t('email_composer.schedule_preset.tomorrow_afternoon', 'Tomorrow afternoon');
    case 'monday_morning': return t('email_composer.schedule_preset.monday_morning', 'Monday morning');
  }
}

/**
 * The release time of a scheduled message, for lists, banners and the
 * "Scheduled" confirmation.
 *
 * The server can land a second before the minute the user picked (08:00
 * showed as 07:59), so the time is rounded to the nearest minute. A message
 * that is not due today also shows its date; a bare "07:59" for tomorrow
 * morning read like a time that had already passed.
 */
export function formatScheduledSendAt(
  sendAt: string,
  timeFormat: '12h' | '24h',
  locale?: string,
  now: Date = new Date(),
): string {
  const ms = Date.parse(sendAt);
  if (!Number.isFinite(ms)) return sendAt;
  const rounded = new Date(Math.round(ms / 60_000) * 60_000);
  const sameDay = rounded.toDateString() === now.toDateString();
  const time = { hour: '2-digit', minute: '2-digit', hour12: timeFormat === '12h' } as const;
  const options: Intl.DateTimeFormatOptions = sameDay
    ? time
    : { ...time, weekday: 'short', month: 'short', day: 'numeric' };
  try {
    return rounded.toLocaleString(intlLocale(locale), options);
  } catch {
    return rounded.toLocaleString();
  }
}
