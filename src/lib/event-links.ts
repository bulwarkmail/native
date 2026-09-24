/**
 * What an event's place fields should do when tapped.
 *
 * Meeting invitations rarely fill `virtualLocations`: a Teams invite arrives
 * with LOCATION set to "Microsoft Teams Meeting" and the join URL buried in
 * the description, among dial-in numbers and help links. `findMeetingLink`
 * digs it out so the sheet can offer one "Join" button without touching the
 * event on the server (it is someone else's invitation).
 *
 * A physical address is handed to the platform's maps app instead.
 */

import type { CalendarEvent } from '../api/types';

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
  { name: 'Zoom', host: /(^|\.)zoom\.us$/, path: /^\/(j|w|my|s)\//i },
  { name: 'Google Meet', host: /^meet\.google\.com$/, path: /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i },
  { name: 'Webex', host: /(^|\.)webex\.com$/, path: /^\/(meet|join|[^/]+\/j\.php)/i },
  { name: 'Jitsi', host: /^meet\.jit\.si$/, path: /^\/./ },
  { name: 'Whereby', host: /^whereby\.com$/, path: /^\/./ },
  { name: 'GoTo', host: /^(meet\.goto\.com|global\.gotomeeting\.com|app\.gotomeeting\.com)$/, path: /^\/./ },
  { name: 'Visio', host: /^(visio|webconf)\.numerique\.gouv\.fr$/, path: /^\/./ },
];

const URL_RE = /https?:\/\/[^\s<>"']+/g;

const isHttpUrl = (value: string | undefined | null): value is string =>
  !!value && /^https?:\/\/\S+$/i.test(value.trim());

/**
 * Outlook's Safe Links and similar gateways wrap the real URL in a query
 * parameter; unwrap one level so the provider can be recognised.
 */
export function unwrapSafeLink(uri: string): string {
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
  if (!text) return null;
  for (const raw of text.match(URL_RE) ?? []) {
    // Trailing punctuation belongs to the sentence, not the URL.
    const candidate = unwrapSafeLink(raw.replace(/[).,;:!?\]]+$/, ''));
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
export function findMeetingLink(event: Pick<CalendarEvent, 'virtualLocations' | 'locations' | 'description'>): MeetingLink | null {
  for (const vl of Object.values(event.virtualLocations ?? {})) {
    if (isHttpUrl(vl?.uri)) {
      return { uri: vl.uri.trim(), provider: meetingProviderOf(vl.uri) ?? undefined, derived: false };
    }
  }
  const locations = Object.values(event.locations ?? {});
  for (const loc of locations) {
    const found = firstMeetingUrl(loc?.name) ?? firstMeetingUrl(loc?.description);
    if (found) return found;
  }
  return firstMeetingUrl(event.description);
}

/** The first location's display name, if any. */
export function primaryLocationName(event: Pick<CalendarEvent, 'locations'>): string | undefined {
  const name = Object.values(event.locations ?? {})[0]?.name?.trim();
  return name || undefined;
}

// "Microsoft Teams Meeting", "Réunion Microsoft Teams", "Zoom", "Google Meet"…
// A location like this names the service, not a place: tapping it should join
// the meeting, never search the maps for it.
const MEETING_LABEL_RE = /\b(microsoft teams|teams|zoom|google meet|webex|jitsi|whereby|gotomeeting|visio(conf[ée]rence)?|online|en ligne)\b/i;

export function isMeetingLabel(location: string): boolean {
  return MEETING_LABEL_RE.test(location) && !/\d/.test(location);
}

export type LocationAction =
  | { kind: 'url'; uri: string }
  | { kind: 'maps'; query: string };

/**
 * What tapping the location does: open it when it is a URL, join the meeting
 * when it only names the service, search the maps otherwise.
 */
export function locationAction(location: string, meeting: MeetingLink | null): LocationAction {
  const value = location.trim();
  if (isHttpUrl(value)) return { kind: 'url', uri: value };
  if (meeting && isMeetingLabel(value)) return { kind: 'url', uri: meeting.uri };
  return { kind: 'maps', query: value };
}

/**
 * A maps URL for a free-text address. Android's `geo:` intent opens Google
 * Maps (or the user's chosen maps app) straight on the search; elsewhere the
 * Google Maps universal link opens the app when installed, the site otherwise.
 */
export function mapsUrl(query: string, platform: string): string {
  const q = encodeURIComponent(query.replace(/\s+/g, ' ').trim());
  if (platform === 'android') return `geo:0,0?q=${q}`;
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}
