/**
 * Value tables between JSCalendar and CalendarContract (docs/device-sync.md,
 * "Other properties"): status, availability, privacy, colours and the
 * attendee enums. Pure lookups, both directions.
 */
import {
  AttendeeRelationship,
  AttendeeStatus,
  AttendeeType,
  EventAccess,
  EventAvailability,
  EventStatus,
  ReminderMethod,
} from '../android-columns';
import { NAMED_COLORS } from '../../lib/css-named-colors';

// ─── Event status, availability, privacy ─────────────────

/** `status` → STATUS; absent (JSCalendar's default is confirmed) → CONFIRMED. Never null: the provider throws on it. */
export function statusToDevice(status: unknown): number {
  switch (String(status ?? '').toLowerCase()) {
    case 'tentative':
      return EventStatus.TENTATIVE;
    case 'cancelled':
      return EventStatus.CANCELED;
    default:
      return EventStatus.CONFIRMED;
  }
}

/**
 * STATUS → `status`; null when the row has none. CalendarProvider has no
 * default for STATUS, and apps that do not model it (Google Calendar) leave
 * it NULL on the events and exceptions they insert: that sets no status.
 */
export function statusFromDevice(value: unknown): 'confirmed' | 'tentative' | 'cancelled' | null {
  if (isUnsetStatus(value)) return null;
  const n = Number(value);
  if (n === EventStatus.TENTATIVE) return 'tentative';
  if (n === EventStatus.CANCELED) return 'cancelled';
  return 'confirmed';
}

/** A STATUS cell an app left NULL (see `statusFromDevice`). */
export function isUnsetStatus(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/** `freeBusyStatus` → AVAILABILITY; JSCalendar's default is busy. */
export function availabilityToDevice(freeBusy: unknown): number {
  return String(freeBusy ?? '').toLowerCase() === 'free' ? EventAvailability.FREE : EventAvailability.BUSY;
}

/** AVAILABILITY → `freeBusyStatus`; TENTATIVE has no JSCalendar value and uploads as busy. */
export function availabilityFromDevice(value: unknown): 'free' | 'busy' {
  return Number(value) === EventAvailability.FREE ? 'free' : 'busy';
}

/** `privacy` → ACCESS_LEVEL: absent DEFAULT, public PUBLIC, private PRIVATE, secret CONFIDENTIAL. */
export function privacyToDevice(privacy: unknown): number {
  switch (String(privacy ?? '').toLowerCase()) {
    case 'public':
      return EventAccess.PUBLIC;
    case 'private':
      return EventAccess.PRIVATE;
    case 'secret':
      return EventAccess.CONFIDENTIAL;
    default:
      return EventAccess.DEFAULT;
  }
}

/** ACCESS_LEVEL → `privacy`; DEFAULT removes the property. */
export function privacyFromDevice(value: unknown): 'public' | 'private' | 'secret' | null {
  switch (Number(value)) {
    case EventAccess.PUBLIC:
      return 'public';
    case EventAccess.PRIVATE:
      return 'private';
    case EventAccess.CONFIDENTIAL:
      return 'secret';
    default:
      return null;
  }
}

// ─── Attendees ──────────────────────────────────────────

/** participationStatus → ATTENDEE_STATUS: accepted 1, declined 2, needs-action (the default) 3, tentative 4, else NONE. */
export function participationToDevice(status: unknown): number {
  switch (String(status ?? 'needs-action').toLowerCase()) {
    case 'accepted':
      return AttendeeStatus.ACCEPTED;
    case 'declined':
      return AttendeeStatus.DECLINED;
    case 'needs-action':
      return AttendeeStatus.INVITED;
    case 'tentative':
      return AttendeeStatus.TENTATIVE;
    default:
      return AttendeeStatus.NONE;
  }
}

/** ATTENDEE_STATUS → participationStatus; NONE has no JSCalendar value. */
export function participationFromDevice(value: unknown): string | null {
  switch (Number(value)) {
    case AttendeeStatus.ACCEPTED:
      return 'accepted';
    case AttendeeStatus.DECLINED:
      return 'declined';
    case AttendeeStatus.INVITED:
      return 'needs-action';
    case AttendeeStatus.TENTATIVE:
      return 'tentative';
    default:
      return null;
  }
}

/** ATTENDEE_TYPE: the `optional` role → OPTIONAL, kind resource/location → RESOURCE, else REQUIRED. */
export function attendeeTypeToDevice(participant: { roles?: Record<string, boolean> | null; kind?: string | null }): number {
  const kind = String(participant.kind ?? '').toLowerCase();
  if (kind === 'resource' || kind === 'location') return AttendeeType.RESOURCE;
  if (participant.roles?.optional) return AttendeeType.OPTIONAL;
  return AttendeeType.REQUIRED;
}

export function relationshipToDevice(isOrganizer: boolean): number {
  return isOrganizer ? AttendeeRelationship.ORGANIZER : AttendeeRelationship.ATTENDEE;
}

// ─── Reminders ──────────────────────────────────────────

/** Reminders.METHOD for an alert action: email → EMAIL, anything else → ALERT. */
export function reminderMethodToDevice(action: unknown): number {
  return String(action ?? '').toLowerCase() === 'email' ? ReminderMethod.EMAIL : ReminderMethod.ALERT;
}

/** The alert action of a METHOD: EMAIL → email; DEFAULT, ALERT, ALARM and SMS all fire a notification. */
export function reminderActionFromDevice(method: unknown): 'email' | 'display' {
  return Number(method) === ReminderMethod.EMAIL ? 'email' : 'display';
}

// ─── Colours ────────────────────────────────────────────



/**
 * A CSS colour (a name, `#rgb` or `#rrggbb`) as the signed 32-bit ARGB int
 * the provider stores, fully opaque; null for anything else.
 */
export function cssColorToArgb(color: unknown): number | null {
  if (typeof color !== 'string') return null;
  const c = color.trim().toLowerCase();
  let hex = NAMED_COLORS[c] ?? null;
  if (!hex) {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(c);
    if (!m) return null;
    hex = m[1].length === 3 ? m[1].split('').map((ch) => ch + ch).join('') : m[1];
  }
  return (0xff000000 | parseInt(hex, 16)) | 0;
}

/** An ARGB int as `#rrggbb` (the alpha is dropped: JSCalendar colours are opaque). */
export function argbToCss(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return `#${((n >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;
}
