/**
 * What an event's place fields should do when tapped.
 *
 * Meeting invitations rarely fill `virtualLocations`: a Teams invite arrives
 * with LOCATION set to "Microsoft Teams Meeting" and the join URL buried in
 * the description, among dial-in numbers and help links. `findMeetingLink`
 * digs it out so the popover can offer the meeting link without touching the
 * event on the server (it is someone else's invitation).
 *
 * A physical address opens in the maps instead.
 *
 * Every field read here is sender-controlled. Links must pass the app's
 * `isSafeExternalUrl` (the same scheme allow-list `openExternalUrl` enforces),
 * and all text is length-bounded before any regex runs over it.
 */

import { isSafeExternalUrl } from './open-url';

/** The place fields read here, loose enough for any event shape. */
export interface EventPlaces {
  locations?: Record<string, { name?: string | null; description?: string | null } | null> | null;
  virtualLocations?: Record<string, { uri?: string | null } | null> | null;
  description?: string | null;
}

export interface MeetingLink {
  uri: string;
  /** Display name of the conferencing service, when recognised. */
  provider?: string;
  /** True when the link was found in the description, not a structured field. */
  derived: boolean;
}

// Hosts whose URLs are joinable meetings. The path test keeps help pages,
// "learn more" and dial-in links on the same host out of the result.
const PROVIDERS: Array<{ name: string; host: RegExp; path?: RegExp }> = [
  { name: 'Teams', host: /^teams\.(microsoft|live)\.com$/, path: /^\/(l\/meetup-join|meet)\//i },
  { name: 'Zoom', host: /(^|\.)zoom\.us$/, path: /^\/(j|w|wc|my|s)\//i },
  { name: 'Google Meet', host: /^meet\.google\.com$/, path: /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i },
  { name: 'Webex', host: /(^|\.)webex\.com$/, path: /^\/(meet|join|[^/]+\/j\.php)/i },
  { name: 'Jitsi', host: /^meet\.jit\.si$/, path: /^\/./ },
  { name: 'Whereby', host: /^whereby\.com$/, path: /^\/./ },
  { name: 'GoTo', host: /^(meet\.goto\.com|global\.gotomeeting\.com|app\.gotomeeting\.com)$/, path: /^\/./ },
  { name: 'Visio', host: /^(visio|webconf)\.numerique\.gouv\.fr$/, path: /^\/./ },
];

// Sender-controlled text is cut to a window before any scan (the same bound
// the verification-code detector uses), so no pattern sees unbounded input.
const MAX_TEXT = 50_000;
const MAX_URL = 2048;
const MAX_CANDIDATES = 100;
const MAX_LOCATION = 1000;

const bound = (text: string | undefined | null, max = MAX_TEXT): string | undefined =>
  text ? text.slice(0, max) : undefined;

const URL_RE = /https?:\/\/[^\s<>"']+/g;

const isHttpUrl = (value: string | undefined | null): value is string => {
  if (!value || value.length > MAX_URL + 2) return false;
  const v = value.trim();
  return /^https?:\/\/\S+$/i.test(v) && isSafeExternalUrl(v);
};

/** Drop trailing sentence punctuation without a backtracking pattern. */
function trimTrailingPunctuation(raw: string): string {
  let end = raw.length;
  while (end > 0 && ').,;:!?]'.includes(raw[end - 1])) end--;
  return raw.slice(0, end);
}

/**
 * Outlook's Safe Links and similar gateways wrap the real URL in a query
 * parameter; unwrap one level so the provider can be recognised.
 */
export function unwrapSafeLink(uri: string): string {
  if (uri.length > MAX_URL) return uri;
  try {
    const u = new URL(uri);
    if (/(^|\.)safelinks\.protection\.outlook\.com$/i.test(u.hostname)) {
      const inner = u.searchParams.get('url');
      if (inner && isHttpUrl(inner)) return inner;
    }
  } catch {
    // not a parseable URL - keep as is
  }
  return uri;
}

/** The conferencing service a URL joins, or null for any other link. */
export function meetingProviderOf(uri: string): string | null {
  if (uri.length > MAX_URL) return null;
  let u: URL;
  try {
    u = new URL(unwrapSafeLink(uri));
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const provider = PROVIDERS.find((p) => p.host.test(host) && (!p.path || p.path.test(u.pathname)));
  return provider ? provider.name : null;
}

function firstMeetingUrl(text: string | undefined | null): MeetingLink | null {
  const window = bound(text);
  if (!window) return null;
  let checked = 0;
  for (const m of window.matchAll(URL_RE)) {
    if (++checked > MAX_CANDIDATES) break;
    if (m[0].length > MAX_URL) continue;
    // Trailing punctuation belongs to the sentence, not the URL.
    const candidate = unwrapSafeLink(trimTrailingPunctuation(m[0]));
    const provider = meetingProviderOf(candidate);
    if (provider) return { uri: candidate, provider, derived: true };
  }
  return null;
}

/**
 * The link that joins the meeting: the event's own virtual location first,
 * then a URL used as the location, then a known conferencing URL found in the
 * location or the description.
 */
export function findMeetingLink(event: EventPlaces): MeetingLink | null {
  for (const vl of Object.values(event.virtualLocations ?? {})) {
    const uri = vl?.uri;
    if (isHttpUrl(uri)) {
      return { uri: uri.trim(), provider: meetingProviderOf(uri) ?? undefined, derived: false };
    }
  }
  const locations = Object.values(event.locations ?? {});
  for (const loc of locations) {
    const found = firstMeetingUrl(loc?.name) ?? firstMeetingUrl(loc?.description);
    if (found) return found;
  }
  const inDescription = firstMeetingUrl(event.description);
  if (inDescription) return inDescription;
  // Last resort: a virtual location in another scheme the app may hand to
  // the OS (tel:, …) still beats no link at all. Deep links the app refuses
  // to open (msteams:, intent:) and script schemes are never offered.
  for (const vl of Object.values(event.virtualLocations ?? {})) {
    const uri = vl?.uri?.trim();
    if (uri && uri.length <= MAX_URL && isSafeExternalUrl(uri)) return { uri, derived: false };
  }
  return null;
}

/** The first location's display name, if any. */
export function primaryLocationName(event: Pick<EventPlaces, 'locations'>): string | undefined {
  const name = bound(Object.values(event.locations ?? {})[0]?.name, MAX_LOCATION)?.trim();
  return name || undefined;
}

// "Microsoft Teams Meeting", "Réunion Microsoft Teams", "Zoom", "Google Meet"…
// A location like this names the service, not a place: tapping it should join
// the meeting, never search the maps for it. The whole label must be a service
// name, so "Salle Teams" or "Studio Zoom" stay places.
const MEETING_LABELS = new Set([
  'microsoft teams', 'teams', 'zoom', 'google meet', 'meet', 'webex', 'jitsi', 'whereby',
  'gotomeeting', 'goto', 'visio', 'visioconference', 'online', 'en ligne',
]);

export function isMeetingLabel(location: string): boolean {
  const label = location.slice(0, MAX_LOCATION)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(reunion|meeting|online meeting|appel|call) /, '')
    .replace(/ (meeting|reunion|call)$/, '');
  return MEETING_LABELS.has(label);
}

export type LocationAction =
  | { kind: 'url'; uri: string }
  | { kind: 'maps'; query: string };

/**
 * What tapping the location does: open it when it is a URL, join the meeting
 * when it only names the service, search the maps otherwise.
 */
export function locationAction(location: string, meeting: MeetingLink | null): LocationAction {
  const value = location.slice(0, MAX_LOCATION).trim();
  if (isHttpUrl(value)) return { kind: 'url', uri: value };
  if (meeting && isMeetingLabel(value)) return { kind: 'url', uri: meeting.uri };
  return { kind: 'maps', query: value };
}

/**
 * A maps URL for a free-text address. The Google Maps universal link opens
 * the Maps app on a phone when it is installed, the site otherwise.
 */
export function mapsUrl(query: string): string {
  const q = encodeURIComponent(query.slice(0, MAX_LOCATION).replace(/\s+/g, ' ').trim());
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}
