import { eachYearOfInterval, parseISO } from 'date-fns';
import type { Calendar, CalendarEvent, ContactCard, AnniversaryDate } from '../api/types';
import { getContactDisplayName } from './contact-utils';

export const BIRTHDAY_CALENDAR_ID = '__birthday-calendar__';
export const BIRTHDAY_CALENDAR_COLOR = '#eab308'; // yellow

// A read-only virtual calendar holding generated birthday events.
export function createBirthdayCalendar(name = 'Birthdays'): Calendar {
  return {
    id: BIRTHDAY_CALENDAR_ID,
    name,
    color: BIRTHDAY_CALENDAR_COLOR,
    sortOrder: 999,
    isSubscribed: true,
    isVisible: true,
    isDefault: false,
    myRights: {
      mayReadItems: true,
      mayWriteAll: false,
      mayWriteOwn: false,
      mayWrite: false,
      mayDelete: false,
      mayRSVP: false,
    },
  };
}

function parseBirthdayDate(date: AnniversaryDate): { month: number; day: number; year?: number } | null {
  if (typeof date === 'string') {
    if (date.startsWith('--')) {
      const m = date.match(/^--(\d{2})-(\d{2})$/);
      return m ? { month: parseInt(m[1], 10), day: parseInt(m[2], 10) } : null;
    }
    const parsed = parseISO(date);
    if (!isNaN(parsed.getTime())) {
      return { month: parsed.getMonth() + 1, day: parsed.getDate(), year: parsed.getFullYear() };
    }
    return null;
  }
  if ('utc' in date && date['@type'] === 'Timestamp') {
    const parsed = parseISO(date.utc);
    if (!isNaN(parsed.getTime())) {
      return { month: parsed.getMonth() + 1, day: parsed.getDate(), year: parsed.getFullYear() };
    }
    return null;
  }
  // PartialDate
  if (date.month && date.day) {
    return { month: date.month, day: date.day, year: date.year || undefined };
  }
  return null;
}

// Generate virtual all-day birthday events for the given range from contacts
// that carry a `birth` anniversary.
export function generateBirthdayEvents(
  contacts: ContactCard[],
  rangeStart: string,
  rangeEnd: string,
): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  const start = parseISO(rangeStart);
  const end = parseISO(rangeEnd);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return events;

  const years = eachYearOfInterval({ start, end });
  const endYear = end.getFullYear();
  if (!years.some((y) => y.getFullYear() === endYear)) {
    years.push(new Date(endYear, 0, 1));
  }

  for (const contact of contacts) {
    if (!contact.anniversaries) continue;
    for (const [key, anniversary] of Object.entries(contact.anniversaries)) {
      if (anniversary.kind !== 'birth') continue;
      const parsed = parseBirthdayDate(anniversary.date);
      if (!parsed) continue;
      const displayName = getContactDisplayName(contact);
      if (!displayName) continue;

      for (const yearDate of years) {
        const year = yearDate.getFullYear();
        // Feb 29 in a non-leap year: clamp to Feb 28.
        let occMonth = parsed.month;
        let occDay = parsed.day;
        const occurrence = new Date(year, occMonth - 1, occDay);
        if (occurrence.getMonth() !== occMonth - 1) {
          occurrence.setDate(0);
          occMonth = occurrence.getMonth() + 1;
          occDay = occurrence.getDate();
        }
        if (occurrence < start || occurrence > end) continue;

        const mm = String(occMonth).padStart(2, '0');
        const dd = String(occDay).padStart(2, '0');
        const age = parsed.year ? year - parsed.year : undefined;
        const ageText = age && age > 0 ? ` (${age})` : '';

        events.push({
          id: `birthday-${contact.id}-${key}-${year}`,
          '@type': 'Event',
          uid: `birthday-${contact.id}-${key}`,
          calendarIds: { [BIRTHDAY_CALENDAR_ID]: true },
          title: `🎂 ${displayName}${ageText}`,
          start: `${year}-${mm}-${dd}T00:00:00`,
          duration: 'P1D',
          showWithoutTime: true,
          status: 'confirmed',
          freeBusyStatus: 'free',
          color: BIRTHDAY_CALENDAR_COLOR,
        });
      }
    }
  }
  return events;
}
