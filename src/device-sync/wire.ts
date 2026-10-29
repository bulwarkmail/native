/**
 * JMAP objects as the device sync engine sees them: exactly as Stalwart sends
 * and accepts them, without the client-only fields the app's stores add.
 * Stalwart speaks JSCalendar 2.0, so `recurrenceRule` is singular on the wire
 * (plural `recurrenceRules` and `excludedRecurrenceRule(s)` are rejected), and
 * override values are PatchObjects.
 */
import type {
  AddressBook,
  Alert,
  Calendar,
  CalendarEvent,
  ContactCard,
  RecurrenceRule,
} from '../api/types';

type ContactClientOnly = 'accountId' | 'accountName' | 'isShared' | 'originalId';
type EventClientOnly =
  | 'recurrenceRules'
  | 'excludedRecurrenceRules'
  | 'recurrenceOverrides'
  | 'originalId'
  | 'originalCalendarIds'
  | 'localAccountId'
  | 'accountId'
  | 'isShared'
  | 'baseEventId'
  | 'utcStart'
  | 'utcEnd';
type CalendarClientOnly = 'accountId' | 'originalId' | 'isShared' | 'colorIsLocalOverride';

/** A ContactCard (RFC 9553) on the wire. Unknown properties are kept as they came. */
export type ContactCardWire = Omit<ContactCard, ContactClientOnly> & {
  '@type'?: string;
  version?: string;
  [property: string]: unknown;
};

/** A CalendarEvent (JSCalendar 2.0 as Stalwart speaks it) on the wire. */
export type CalendarEventWire = Omit<CalendarEvent, EventClientOnly> & {
  recurrenceRule?: RecurrenceRule | null;
  /** Keys are LocalDateTimes in the event's zone; values are PatchObjects against the master. */
  recurrenceOverrides?: Record<string, Record<string, unknown>> | null;
  [property: string]: unknown;
};

export type AddressBookLike = Omit<AddressBook, ContactClientOnly>;

export type CalendarLike = Omit<Calendar, CalendarClientOnly> & {
  defaultAlertsWithTime?: Record<string, Alert> | null;
  defaultAlertsWithoutTime?: Record<string, Alert> | null;
  timeZone?: string | null;
  includeInAvailability?: string;
};

/** Every ContactCard property the engine asks `/get` for (explicit, see docs/device-sync.md). */
export const CONTACT_CARD_PROPERTIES = [
  'id', 'uid', 'addressBookIds', 'kind', 'language', 'name', 'nicknames', 'emails', 'phones',
  'onlineServices', 'preferredLanguages', 'organizations', 'titles', 'addresses', 'anniversaries',
  'personalInfo', 'notes', 'media', 'relatedTo', 'links', 'cryptoKeys', 'directories', 'keywords',
  'members', 'speakToAs', 'calendars', 'schedulingAddresses', 'localizations', 'prodId', 'created',
  'updated', '@type', 'version',
] as const;

/** Every CalendarEvent property the engine asks `/get` for; `properties: null` would drop `useDefaultAlerts`. */
export const CALENDAR_EVENT_PROPERTIES = [
  'id', 'uid', '@type', 'calendarIds', 'isDraft', 'title', 'description', 'descriptionContentType',
  'start', 'duration', 'timeZone', 'endTimeZone', 'showWithoutTime', 'status', 'freeBusyStatus',
  'privacy', 'color', 'keywords', 'categories', 'priority', 'locale', 'sequence', 'method',
  'locations', 'mainLocationId', 'virtualLocations', 'links', 'relatedTo', 'participants',
  'organizerCalendarAddress', 'replyTo', 'sentBy', 'recurrenceRule', 'recurrenceOverrides',
  'recurrenceId', 'recurrenceIdTimeZone', 'alerts', 'useDefaultAlerts', 'created', 'updated',
  'prodId', 'progress', 'due', 'estimatedDuration', 'percentComplete',
] as const;

export const ADDRESS_BOOK_PROPERTIES = [
  'id', 'name', 'description', 'sortOrder', 'isDefault', 'isSubscribed', 'myRights',
] as const;

export const CALENDAR_PROPERTIES = [
  'id', 'name', 'description', 'color', 'sortOrder', 'isSubscribed', 'isVisible', 'isDefault',
  'includeInAvailability', 'defaultAlertsWithTime', 'defaultAlertsWithoutTime', 'timeZone', 'myRights',
] as const;
