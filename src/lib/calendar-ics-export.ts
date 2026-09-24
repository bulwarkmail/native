import type { CalendarEvent } from '../api/types';
import { t } from '../stores/locale-store';

// Port of the webmail's lib/calendar-ics-export.ts: serialise one event as
// an RFC 5545 VCALENDAR so it can be shared as a .ics file.

const MAX_LINE_OCTETS = 74;

function foldLine(line: string): string {
  if (line.length <= MAX_LINE_OCTETS) return line;
  const chunks: string[] = [line.slice(0, MAX_LINE_OCTETS)];
  let pos = MAX_LINE_OCTETS;
  while (pos < line.length) {
    chunks.push(' ' + line.slice(pos, pos + MAX_LINE_OCTETS - 1));
    pos += MAX_LINE_OCTETS - 1;
  }
  return chunks.join('\r\n');
}

// RFC 5545 §3.3.11 - escape backslash, semicolon, comma, and newline in TEXT values.
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

function stripDateSeparators(value: string): string {
  return value.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function dateOnly(value: string): string {
  return value.replace(/-/g, '').substring(0, 8);
}

function formatNow(): string {
  return stripDateSeparators(new Date().toISOString().replace(/\.\d{3}/, ''));
}

function pushDateProp(
  lines: string[],
  prop: 'DTSTART' | 'DTEND',
  value: string,
  showWithoutTime: boolean,
  tz?: string | null,
): void {
  if (showWithoutTime) {
    lines.push(`${prop};VALUE=DATE:${dateOnly(value)}`);
    return;
  }
  if (value.endsWith('Z')) {
    lines.push(`${prop}:${stripDateSeparators(value)}`);
    return;
  }
  const basic = stripDateSeparators(value);
  if (tz) {
    lines.push(`${prop};TZID=${tz}:${basic}`);
  } else {
    lines.push(`${prop}:${basic}`);
  }
}

function pushFrequencyRule(lines: string[], event: CalendarEvent): void {
  const rule = event.recurrenceRules?.[0];
  if (!rule) return;
  const parts: string[] = [`FREQ=${rule.frequency.toUpperCase()}`];
  if (rule.interval && rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.count != null) parts.push(`COUNT=${rule.count}`);
  if (rule.until) parts.push(`UNTIL=${stripDateSeparators(rule.until)}`);
  if (rule.byDay?.length) {
    const days = rule.byDay
      .map((d) => `${d.nthOfPeriod ?? ''}${d.day.toUpperCase()}`)
      .join(',');
    parts.push(`BYDAY=${days}`);
  }
  if (rule.byMonthDay?.length) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`);
  if (rule.byMonth?.length) parts.push(`BYMONTH=${rule.byMonth.join(',')}`);
  lines.push(`RRULE:${parts.join(';')}`);
}

function pushAlerts(lines: string[], event: CalendarEvent): void {
  if (!event.alerts) return;
  for (const alert of Object.values(event.alerts)) {
    const trigger = alert.trigger;
    if (!trigger) continue;
    lines.push('BEGIN:VALARM');
    lines.push(`ACTION:${(alert.action || 'display').toUpperCase()}`);
    if (trigger['@type'] === 'OffsetTrigger' && trigger.offset) {
      const related = trigger.relativeTo === 'end' ? ';RELATED=END' : '';
      lines.push(`TRIGGER${related}:${trigger.offset}`);
    } else if (trigger['@type'] === 'AbsoluteTrigger' && trigger.when) {
      lines.push(`TRIGGER;VALUE=DATE-TIME:${stripDateSeparators(trigger.when)}`);
    }
    // Other calendar apps show this when the alarm goes off.
    lines.push(`DESCRIPTION:${escapeText(event.title || t('calendar.tasks.alert', 'Reminder'))}`);
    lines.push('END:VALARM');
  }
}

function participantEmail(p: { email?: string; calendarAddress?: string; sendTo?: Record<string, string> }): string | undefined {
  return (
    p.email
    || p.calendarAddress?.replace(/^mailto:/i, '')
    || p.sendTo?.imip?.replace(/^mailto:/i, '')
  );
}

export function eventToICS(event: CalendarEvent): string {
  const now = formatNow();
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'PRODID:-//Bulwark Mobile//EN',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${event.uid}`,
    `DTSTAMP:${now}`,
  ];

  if (event.created) lines.push(`CREATED:${stripDateSeparators(event.created)}`);
  if (event.updated) lines.push(`LAST-MODIFIED:${stripDateSeparators(event.updated)}`);
  if (event.sequence != null) lines.push(`SEQUENCE:${event.sequence}`);

  const allDay = !!event.showWithoutTime;
  if (event.start) {
    pushDateProp(lines, 'DTSTART', event.start, allDay, event.timeZone);
  }
  if (event.utcEnd && !allDay) {
    pushDateProp(lines, 'DTEND', event.utcEnd, allDay, event.timeZone);
  } else if (event.duration) {
    lines.push(`DURATION:${event.duration}`);
  }

  if (event.title) lines.push(`SUMMARY:${escapeText(event.title)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  if (event.status) lines.push(`STATUS:${event.status.toUpperCase()}`);
  if (event.freeBusyStatus) {
    lines.push(`TRANSP:${event.freeBusyStatus === 'free' ? 'TRANSPARENT' : 'OPAQUE'}`);
  }

  if (event.locations) {
    const first = Object.values(event.locations)[0];
    if (first?.name) lines.push(`LOCATION:${escapeText(first.name)}`);
  }
  if (event.virtualLocations) {
    for (const loc of Object.values(event.virtualLocations)) {
      if (loc.uri) lines.push(`URL:${loc.uri}`);
    }
  }

  if (event.participants) {
    const organizerEmail = event.organizerCalendarAddress?.replace(/^mailto:/i, '').toLowerCase();
    const organizer = Object.values(event.participants).find(
      (p) => p.roles?.owner || (organizerEmail && participantEmail(p)?.toLowerCase() === organizerEmail),
    );
    const orgEmail = organizer ? participantEmail(organizer) : organizerEmail;
    if (orgEmail) {
      const cn = organizer?.name ? `;CN=${escapeText(organizer.name)}` : '';
      lines.push(`ORGANIZER${cn}:mailto:${orgEmail}`);
    }
    for (const p of Object.values(event.participants)) {
      if (p === organizer) continue;
      const email = participantEmail(p);
      if (!email) continue;
      const cn = p.name ? `;CN=${escapeText(p.name)}` : '';
      const partstat = p.participationStatus
        ? `;PARTSTAT=${p.participationStatus.toUpperCase()}`
        : ';PARTSTAT=NEEDS-ACTION';
      const rsvp = p.expectReply ? ';RSVP=TRUE' : '';
      lines.push(`ATTENDEE${cn}${partstat}${rsvp}:mailto:${email}`);
    }
  }

  pushFrequencyRule(lines, event);
  pushAlerts(lines, event);

  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');

  return lines.map(foldLine).join('\r\n') + '\r\n';
}

export function icsFilename(event: CalendarEvent): string {
  const base = (event.title || 'event').replace(/[^a-z0-9\-_ ]/gi, '').trim().replace(/\s+/g, '-');
  return `${base.slice(0, 60) || 'event'}.ics`;
}

/** The first meeting link of an event, if any. */
export function getMeetingLink(event: Pick<CalendarEvent, 'virtualLocations'>): string | null {
  if (!event.virtualLocations) return null;
  for (const loc of Object.values(event.virtualLocations)) {
    if (loc.uri) return loc.uri;
  }
  return null;
}

/** Write the .ics to the cache directory and open the OS share sheet. */
export async function shareEventICS(event: CalendarEvent): Promise<void> {
  const [{ File, Paths }, Sharing] = await Promise.all([
    import('expo-file-system'),
    import('expo-sharing'),
  ]);
  const file = new File(Paths.cache, icsFilename(event));
  if (file.exists) file.delete();
  file.write(eventToICS(event));
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error(t('files.share_unavailable', 'Sharing is not available on this device'));
  }
  await Sharing.shareAsync(file.uri, { mimeType: 'text/calendar', UTI: 'com.apple.ical.ics' });
}
