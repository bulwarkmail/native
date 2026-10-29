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

/** CSS named colours (CSS Color Module Level 4), as `name:rrggbb`. */
const NAMED_COLORS = Object.fromEntries(
  (
    'aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 ' +
    'black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 ' +
    'cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc ' +
    'crimson:dc143c cyan:00ffff darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 ' +
    'darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f ' +
    'darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f ' +
    'darkslateblue:483d8b darkslategray:2f4f4f darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 ' +
    'deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 dodgerblue:1e90ff firebrick:b22222 ' +
    'floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 ' +
    'goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0 hotpink:ff69b4 ' +
    'indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5 ' +
    'lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff ' +
    'lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 ' +
    'lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 ' +
    'lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff ' +
    'maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db ' +
    'mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc ' +
    'mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 ' +
    'navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 ' +
    'orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee ' +
    'palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd ' +
    'powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 ' +
    'saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d ' +
    'silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa ' +
    'springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 ' +
    'turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 ' +
    'yellowgreen:9acd32'
  )
    .split(' ')
    .map((pair) => pair.split(':') as [string, string]),
);

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
