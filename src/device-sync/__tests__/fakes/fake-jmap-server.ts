/**
 * An in-memory JMAP server for the device-sync engine tests (#34), standing
 * in for Stalwart v0.16.23 behind a `JmapPort`. It holds several accounts (a
 * personal one plus shared ones), each with address books, contact cards,
 * calendars and calendar events, and answers the method calls the engine
 * makes the way Stalwart does: per-type states over one change log per
 * collection, `/changes` compaction and paging with intermediate states, JSON
 * Pointer patches, the uid rules, `ifInState`, result references, limits and
 * the normalisation Stalwart applies on write. docs/device-sync.md describes
 * the engine; each Stalwart rule below names where it comes from ("verified":
 * checked against the live server; otherwise read from the Stalwart and
 * calcard sources).
 *
 * Tests also drive it from the outside: seed helpers, edits by another
 * client, positional re-keying (an object written over DAV without PROP-IDs),
 * and fault injection (transport errors, a lost response, a truncated change
 * log, a lagging uid index, per-object SetErrors, limits).
 *
 * Not emulated: ghost entries left by `map/key: null` (deleted cleanly
 * here), partial overrides from deep pointers, per-instance (synthetic) ids,
 * `utcStart`/`utcEnd`, `expandRecurrences`, query anchors and text filters,
 * DST gaps and unknown time zones, duration rewriting, object sizes and
 * quotas (inject them with `setErrorFor`), and the state jump after a cache
 * rebuild. Method names Stalwart knows but the fake does not implement
 * answer `unknownMethod` with a description saying so.
 *
 * Pure TypeScript: no React Native, expo or node imports.
 */

import type {
  JmapAccountView,
  JmapInvocation,
  JmapPort,
  JmapResponse,
  JmapSessionView,
} from '../../types';
import { JMAP_CALENDARS, JMAP_CONTACTS, JMAP_CORE } from '../../types';

// ─── Public types ──────────────────────────────────────

export type DataType = 'AddressBook' | 'ContactCard' | 'Calendar' | 'CalendarEvent';
export type ItemType = 'ContactCard' | 'CalendarEvent';
export type ContainerType = 'AddressBook' | 'Calendar';

/**
 * A change log. Stalwart keeps one per collection: AddressBook and
 * ContactCard share one, Calendar and CalendarEvent the other, and each
 * `/changes` call filters it to its own type.
 */
export type TypeGroup = 'contacts' | 'calendars';

export type FaultKind = 'network' | 'timeout' | 'auth' | 'rateLimit';

export interface SetErrorShape {
  type: string;
  description?: string;
  properties?: string[];
  [extra: string]: unknown;
}

export interface FakeLimits {
  maxObjectsInGet: number;
  maxObjectsInSet: number;
  maxCallsInRequest: number;
  /** Bytes of the serialised request. */
  maxSizeRequest: number;
  /** Server cap on `/changes` `maxChanges` (Stalwart: 5000). */
  maxChanges: number;
  /** Server cap on `/query` `limit` (Stalwart: 5000). */
  maxQueryResults: number;
}

export interface AccountOptions {
  name: string;
  /** Default true. The first personal account with a capability is its primary account. */
  isPersonal?: boolean;
  isReadOnly?: boolean;
  /** Capabilities the account advertises; both by default. */
  capabilities?: Array<'contacts' | 'calendars'>;
  /**
   * The owner's calendar addresses, without `mailto:`: they decide
   * `isOrigin` and the organizer Stalwart assigns. Default: the name, when it
   * is an email address.
   */
  addresses?: string[];
}

export interface RequestRecord {
  seq: number;
  using: string[];
  calls: JmapInvocation[];
  methods: string[];
  /** What the server answered; null when the request never ran. */
  responses: JmapInvocation[] | null;
  /**
   * `ok`: answered. `failed`: a transport fault before anything ran. `lost`:
   * ran (writes applied), then the response was lost. `rejected`: refused as
   * a whole (a request-level limit).
   */
  outcome: 'ok' | 'failed' | 'lost' | 'rejected';
  fault?: FaultKind;
}

export interface SchedulingRecord {
  accountId: string;
  op: 'create' | 'update' | 'destroy';
  id: string;
  requestSeq: number;
}

export interface FaultOptions {
  /** Run the request (writes are applied), then fail it: a lost response. */
  applied?: boolean;
  /** For `rateLimit`. Default 1000. */
  retryAfterMs?: number;
  /** How many matching requests fail. Default 1. */
  times?: number;
  /** Only requests with a method call of this name, or passing this test. */
  match?: string | ((calls: JmapInvocation[]) => boolean);
}

/** One object a `/set` call touches, as `setErrorFor` matchers see it. */
export interface SetTarget {
  op: 'create' | 'update' | 'destroy';
  /** The creation id for creates, else the object id. */
  id: string;
  /** The create object or the PatchObject. */
  object?: Record<string, unknown>;
}

export interface FakeJmapServerOptions {
  /** Clock for `updated` stamps. Default: a manual clock (`setTime`, `advanceTime`). */
  now?: () => number;
  /** Start of the manual clock. Default 2026-01-01T00:00:00Z. */
  startTime?: number;
  limits?: Partial<FakeLimits>;
}

type RequestListener = (request: RequestRecord) => void | Promise<void>;

// ─── Constants ─────────────────────────────────────────

type Obj = Record<string, unknown>;
type Side = 'container' | 'item';
type ChangeOp = 'insert' | 'update' | 'delete';

const DEFAULT_LIMITS: FakeLimits = {
  maxObjectsInGet: 500,
  maxObjectsInSet: 500,
  maxCallsInRequest: 16,
  maxSizeRequest: 10_000_000,
  maxChanges: 5000,
  maxQueryResults: 5000,
};

const ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

/** Prefix of the ids the fake mints, per type (`c1`, `c2`, … `ca`, …). */
const ID_PREFIX: Record<DataType, string> = {
  AddressBook: 'ab',
  ContactCard: 'c',
  Calendar: 'cal',
  CalendarEvent: 'ev',
};

const CAPABILITY_OF: Record<string, string> = {
  Core: JMAP_CORE,
  AddressBook: JMAP_CONTACTS,
  ContactCard: JMAP_CONTACTS,
  Calendar: JMAP_CALENDARS,
  CalendarEvent: JMAP_CALENDARS,
};

const SUPPORTED_METHODS = new Set([
  'Core/echo',
  'AddressBook/get',
  'AddressBook/changes',
  'ContactCard/get',
  'ContactCard/set',
  'ContactCard/query',
  'ContactCard/changes',
  'Calendar/get',
  'Calendar/changes',
  'CalendarEvent/get',
  'CalendarEvent/set',
  'CalendarEvent/query',
  'CalendarEvent/changes',
]);

/** Responses a result reference may point at (Stalwart: /get, /changes, /query, /queryChanges). */
const REFERENCEABLE = /\/(get|changes|query|queryChanges)$/;

/** Top-level ContactCard properties (RFC 9553, RFC 9610); anything else is "Invalid property." (verified). */
const CARD_PROPERTIES = new Set([
  '@type', 'version', 'created', 'kind', 'language', 'members', 'prodId', 'uid', 'updated', 'name',
  'nicknames', 'organizations', 'speakToAs', 'titles', 'emails', 'onlineServices', 'phones',
  'preferredLanguages', 'calendars', 'schedulingAddresses', 'addresses', 'cryptoKeys', 'directories',
  'links', 'media', 'localizations', 'anniversaries', 'keywords', 'notes', 'personalInfo', 'relatedTo',
  'vCard',
]);

/**
 * Top-level CalendarEvent properties calcard maps: JSCalendar-bis names only.
 * `recurrenceRules`, `excludedRecurrenceRule(s)`, `timeZones`,
 * `progressUpdated` and other JSCalendar 1.0 names are "Invalid property."
 * (verified).
 */
const EVENT_PROPERTIES = new Set([
  '@type', 'uid', 'relatedTo', 'prodId', 'created', 'updated', 'sequence', 'title', 'description',
  'descriptionContentType', 'showWithoutTime', 'locations', 'mainLocationId', 'virtualLocations', 'links',
  'locale', 'keywords', 'categories', 'color', 'recurrenceId', 'recurrenceIdTimeZone', 'recurrenceRule',
  'recurrenceOverrides', 'excluded', 'priority', 'freeBusyStatus', 'privacy', 'replyTo', 'sentBy',
  'participants', 'requestStatus', 'alerts', 'timeZone', 'start', 'duration', 'endTimeZone', 'status',
  'organizerCalendarAddress', 'iCalendar', 'due', 'estimatedDuration', 'percentComplete', 'progress',
]);

/** JMAP-only event flags: booleans stored beside the iCalendar data. */
const EVENT_FLAGS = ['isDraft', 'useDefaultAlerts', 'mayInviteSelf', 'mayInviteOthers', 'hideAttendees'];

/** Computed on read; any value sent is "This property is immutable." (verified for isOrigin). */
const IMMUTABLE_EVENT_PROPERTIES = new Set(['isOrigin', 'baseEventId', 'method']);

/** Properties calcard drops from an override on read (`remove_forbidden_override_patches`). */
const FORBIDDEN_OVERRIDE_PROPERTIES = [
  '@type', 'method', 'organizerCalendarAddress', 'privacy', 'prodId', 'recurrenceId',
  'recurrenceIdTimeZone', 'sentBy', 'uid', 'recurrenceRule', 'recurrenceOverrides',
];

/** Card maps that vanish when empty (no vCard line is written). `keywords` and `members` keep `{}`. */
const CARD_MAPS = [
  'nicknames', 'organizations', 'titles', 'emails', 'onlineServices', 'phones', 'preferredLanguages',
  'calendars', 'schedulingAddresses', 'addresses', 'cryptoKeys', 'directories', 'links', 'media',
  'localizations', 'anniversaries', 'notes', 'personalInfo', 'relatedTo',
];

/** Card maps whose keys are PROP-IDs, regenerated as `k1…kN` when those are lost. */
const CARD_KEYED_MAPS = CARD_MAPS.filter((m) => m !== 'relatedTo' && m !== 'localizations');

/** Event maps that vanish when empty (no iCalendar line or component is written). */
const EVENT_MAPS = [
  'alerts', 'participants', 'locations', 'virtualLocations', 'links', 'recurrenceOverrides', 'keywords',
  'categories', 'relatedTo', 'replyTo',
];

/** Name component kinds that have a vCard N position and so make up a derived `full`. */
const NAME_KINDS = new Set(['surname', 'given', 'given2', 'title', 'credential', 'surname2', 'generation']);

const PRIVACY_RANK = ['public', 'private', 'secret'];

const ADDRESS_BOOK_DEFAULTS: Obj = {
  name: '',
  description: null,
  sortOrder: 0,
  isSubscribed: true,
  shareWith: null,
  myRights: { mayRead: true, mayWrite: true, mayShare: true, mayDelete: true },
};

const CALENDAR_DEFAULTS: Obj = {
  name: '',
  description: null,
  color: null,
  sortOrder: 0,
  isSubscribed: true,
  isVisible: true,
  includeInAvailability: 'all',
  defaultAlertsWithTime: {},
  defaultAlertsWithoutTime: {},
  timeZone: null,
  shareWith: null,
  myRights: {
    mayReadFreeBusy: true,
    mayReadItems: true,
    mayWriteAll: true,
    mayWriteOwn: true,
    mayUpdatePrivate: true,
    mayRSVP: true,
    mayShare: true,
    mayDelete: true,
  },
};

// ─── JSON helpers ──────────────────────────────────────

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function hasOwn(obj: Obj, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Assign an own property, also for the key `__proto__`. */
function setKey(obj: Obj, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
  } else {
    obj[key] = value;
  }
}

/** Drop null members of objects, recursively: the converters write nothing for null. */
function stripNulls(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) stripNulls(item);
    return;
  }
  if (!isObj(value)) return;
  for (const key of Object.keys(value)) {
    if (value[key] === null) delete value[key];
    else stripNulls(value[key]);
  }
}

function booleanSet(ids: string[]): Obj {
  const out: Obj = {};
  for (const id of ids) setKey(out, id, true);
  return out;
}

function invalidProperties(properties: string[], description: string): SetErrorShape {
  return { type: 'invalidProperties', properties, description };
}

class MethodError extends Error {
  constructor(readonly type: string, readonly detail?: string) {
    super(detail ?? type);
  }
}

// ─── State strings ─────────────────────────────────────

// Stalwart's encoding (jmap-proto/src/types/state.rs): `n` for "no changes
// yet", `s` + base32(leb128(changeId)) for an exact state, and `r` +
// base32(leb128(from), leb128(to - from), leb128(itemsSent)) for the
// intermediate state of a paged `/changes`. Base32 uses Stalwart's alphabet.

type ParsedState =
  | { kind: 'initial' }
  | { kind: 'exact'; id: number }
  | { kind: 'intermediate'; from: number; to: number; sent: number };

const BASE32 = 'abcdefghijklmnopqrstuvwxyz792013';

function leb128(value: number, out: number[]): void {
  let n = value;
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
}

function toBase32(bytes: number[]): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

function fromBase32(text: string): number[] | null {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of text) {
    const value = BASE32.indexOf(ch);
    if (value < 0) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >> (bits - 8)) & 0xff);
      bits -= 8;
      buffer &= (1 << bits) - 1;
    }
  }
  return out;
}

function readLeb128(bytes: number[], pos: number): [number, number] | null {
  let value = 0;
  let scale = 1;
  for (let i = pos; i < bytes.length; i++) {
    value += (bytes[i] & 0x7f) * scale;
    if ((bytes[i] & 0x80) === 0) return [value, i + 1];
    scale *= 128;
  }
  return null;
}

function encodeState(state: ParsedState): string {
  const bytes: number[] = [];
  switch (state.kind) {
    case 'initial':
      return 'n';
    case 'exact':
      leb128(state.id, bytes);
      return `s${toBase32(bytes)}`;
    case 'intermediate':
      leb128(state.from, bytes);
      leb128(state.to - state.from, bytes);
      leb128(state.sent, bytes);
      return `r${toBase32(bytes)}`;
  }
}

function parseState(value: string): ParsedState | null {
  const bytes = fromBase32(value.slice(1));
  if (value[0] === 'n') return { kind: 'initial' };
  if (!bytes) return null;
  if (value[0] === 's') {
    const id = readLeb128(bytes, 0);
    if (!id) return null;
    return id[0] === 0 ? { kind: 'initial' } : { kind: 'exact', id: id[0] };
  }
  if (value[0] === 'r') {
    const from = readLeb128(bytes, 0);
    const delta = from && readLeb128(bytes, from[1]);
    const sent = delta && readLeb128(bytes, delta[1]);
    if (!from || !delta || !sent || sent[0] === 0) return null;
    return { kind: 'intermediate', from: from[0], to: from[0] + delta[0], sent: sent[0] };
  }
  return null;
}

function stateOfChangeId(changeId: number): ParsedState {
  return changeId === 0 ? { kind: 'initial' } : { kind: 'exact', id: changeId };
}

// ─── JSON Pointer (jmap-tools semantics) ───────────────

// A PatchObject key containing `/` is a JSON Pointer. jmap-tools parses it
// with RFC 6901's `~0`/`~1` escapes, plus `\` escaping the next character; an
// all-digit segment (other than a leading-zero one like `01`) is an array
// index that can replace an existing member but never add one; `*` is a
// wildcard that makes the patch fail (jmap-tools pointer/parser.rs, eval.rs).

type Segment =
  | { kind: 'key'; key: string }
  | { kind: 'index'; index: number; raw: string }
  | { kind: 'wildcard' };

function parsePointer(value: string): Segment[] {
  const segments: Segment[] = [];
  let token: 'unknown' | 'number' | 'string' | 'wildcard' | 'escaped' = 'unknown';
  let buf = '';
  let num = 0;
  let start = 0;
  const flush = (end: number) => {
    const raw = value.slice(start, end);
    if (token === 'string') {
      segments.push({ kind: 'key', key: buf });
      buf = '';
    } else if (token === 'number') {
      segments.push(raw.length > 1 && raw[0] === '0' ? { kind: 'key', key: raw } : { kind: 'index', index: num, raw });
      num = 0;
    } else if (token === 'wildcard') {
      segments.push({ kind: 'wildcard' });
    } else if (token === 'unknown' && start > 0) {
      segments.push({ kind: 'key', key: '' });
    }
  };
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch >= '0' && ch <= '9' && (token === 'unknown' || token === 'number')) {
      num = num * 10 + Number(ch);
      token = 'number';
    } else if (ch === '*' && token === 'unknown') {
      token = 'wildcard';
    } else if ((ch === '0' || ch === '1') && token === 'escaped') {
      buf += ch === '0' ? '~' : '/';
      token = 'string';
    } else if (ch === '/') {
      flush(i);
      token = 'unknown';
      start = i + 1;
    } else {
      if ((token === 'number' || token === 'wildcard') && i > start) buf += value.slice(start, i);
      if (ch === '~' && token !== 'escaped') {
        token = 'escaped';
      } else if (ch === '\\') {
        i++;
        buf += i < value.length ? value[i] : '\\';
        token = 'string';
      } else {
        buf += ch;
        token = 'string';
      }
    }
  }
  flush(value.length);
  return segments;
}

/**
 * Apply one pointer patch the way `patch_jptr` does: every parent must exist,
 * the last segment replaces or adds a member. One deliberate difference:
 * Stalwart keeps `key: null` in the map, and for most contact maps its
 * converter then leaves a valueless vCard line (or a JSPROP null) behind
 * (research E2). The engine never relies on that and resends the whole map
 * instead, so here a null simply deletes the member.
 */
function applyPointer(node: unknown, segments: Segment[], value: unknown, i = 0): boolean {
  const segment = segments[i];
  if (!segment) return false;
  const last = i === segments.length - 1;
  if (segment.kind === 'key') {
    if (!isObj(node)) return false;
    if (hasOwn(node, segment.key)) {
      if (!last) return applyPointer(node[segment.key], segments, value, i + 1);
      assignOrDelete(node, segment.key, value);
      return true;
    }
    if (!last) return false;
    assignOrDelete(node, segment.key, value);
    return true;
  }
  if (segment.kind === 'index') {
    if (Array.isArray(node)) {
      if (segment.index >= node.length) return false;
      if (!last) return applyPointer(node[segment.index], segments, value, i + 1);
      node[segment.index] = value;
      return true;
    }
    const key = String(segment.index);
    if (isObj(node) && hasOwn(node, key)) {
      if (!last) return applyPointer(node[key], segments, value, i + 1);
      assignOrDelete(node, key, value);
      return true;
    }
  }
  return false;
}

function assignOrDelete(obj: Obj, key: string, value: unknown): void {
  if (value === null) delete obj[key];
  else setKey(obj, key, value);
}

/** A result reference path (RFC 8620 §3.7): a JSON Pointer where `*` maps over an array. */
function resolveReferencePath(root: unknown, path: string): { value: unknown } | null {
  if (path === '') return { value: root };
  if (!path.startsWith('/')) return null;
  const tokens = path.slice(1).split('/').map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
  const walk = (node: unknown, i: number): { value: unknown } | null => {
    if (i === tokens.length) return { value: node };
    const token = tokens[i];
    if (Array.isArray(node)) {
      if (token === '*') {
        const out: unknown[] = [];
        for (const item of node) {
          const result = walk(item, i + 1);
          if (!result) return null;
          if (Array.isArray(result.value)) out.push(...result.value);
          else out.push(result.value);
        }
        return { value: out };
      }
      if (!/^\d+$/.test(token) || Number(token) >= node.length) return null;
      return walk(node[Number(token)], i + 1);
    }
    if (isObj(node) && hasOwn(node, token)) return walk(node[token], i + 1);
    return null;
  };
  return walk(root, 0);
}

// ─── uuid5 ─────────────────────────────────────────────

// calcard keys participants, locations, links and virtual locations that have
// no JSID by uuid5 of their address, name, href or uri in its own namespace
// (7f1e1965-ae73-4454-b088-232c90730ce2, calcard jscalendar/mod.rs).

const JSCAL_NAMESPACE = [0x7f, 0x1e, 0x19, 0x65, 0xae, 0x73, 0x44, 0x54, 0xb0, 0x88, 0x23, 0x2c, 0x90, 0x73, 0x0c, 0xe2];

function sha1(message: Uint8Array): Uint8Array {
  const padded = new Uint8Array((((message.length + 8) >> 6) + 1) << 6);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = message.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let [a, b, c, d, e] = h;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = ((b << 30) | (b >>> 2)) >>> 0;
      b = a;
      a = t;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  h.forEach((value, i) => outView.setUint32(i * 4, value));
  return out;
}

/** The key calcard gives an entry without a stored JSID, e.g. `uuid5('mailto:a@b.c')`. */
export function uuid5(text: string): string {
  const name = new TextEncoder().encode(text);
  const input = new Uint8Array(JSCAL_NAMESPACE.length + name.length);
  input.set(JSCAL_NAMESPACE);
  input.set(name, JSCAL_NAMESPACE.length);
  const hash = sha1(input);
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = Array.from(hash.slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ─── Change log ────────────────────────────────────────

interface Change {
  side: Side;
  op: ChangeOp;
  id: string;
}

interface LogEntry {
  changeId: number;
  /** The truncation marker Stalwart writes where it trimmed the log. */
  marker: boolean;
  changes: Change[];
}

interface ChangeWindow {
  /** Compacted changes by `side:id`, in log order. */
  changes: Map<string, Change>;
  fromChangeId: number;
  toChangeId: number;
  containerChangeId: number | null;
  itemChangeId: number | null;
  isTruncated: boolean;
}

type LogQuery = { all: true } | { since: number } | { from: number; to: number };

/**
 * Compaction inside a window (store/src/query/log.rs): an update after an
 * insert is dropped, an insert then delete vanishes, an update then delete
 * leaves only the delete, and a repeated update moves to the end.
 */
function compact(changes: Map<string, Change>, change: Change): void {
  const key = `${change.side}:${change.id}`;
  const current = changes.get(key);
  if (change.op === 'insert') {
    changes.set(key, change);
    return;
  }
  if (current?.op === 'insert') {
    if (change.op === 'delete') changes.delete(key);
    return;
  }
  changes.delete(key);
  changes.set(key, change);
}

class ChangeLog {
  entries: LogEntry[] = [];
  /** The last change id with container (or item) changes: the type's state. */
  containerChangeId = 0;
  itemChangeId = 0;

  append(changeId: number, changes: Change[]): void {
    this.entries.push({ changeId, marker: false, changes });
    if (changes.some((c) => c.side === 'container')) this.containerChangeId = changeId;
    if (changes.some((c) => c.side === 'item')) this.itemChangeId = changeId;
  }

  sideChangeId(side: Side): number {
    return side === 'container' ? this.containerChangeId : this.itemChangeId;
  }

  /** `Store::changes`: the entries of a range, compacted. */
  query(q: LogQuery): ChangeWindow {
    const [inclusive, from, to]: [boolean, number, number] =
      'all' in q ? [true, 0, Infinity] : 'since' in q ? [false, q.since, Infinity] : [true, q.from, q.to];
    const out: ChangeWindow = {
      changes: new Map(),
      fromChangeId: 0,
      toChangeId: 0,
      containerChangeId: null,
      itemChangeId: null,
      isTruncated: false,
    };
    for (const entry of this.entries) {
      const id = entry.changeId;
      if (id < from || id > to) continue;
      if (!inclusive && id === from) {
        out.fromChangeId = id;
        out.toChangeId = id;
        continue;
      }
      if (entry.marker) {
        out.isTruncated = true;
        continue;
      }
      if (out.changes.size === 0) out.fromChangeId = id;
      out.toChangeId = id;
      let container = false;
      let item = false;
      for (const change of entry.changes) {
        compact(out.changes, change);
        if (change.side === 'container') container = true;
        else item = true;
      }
      if (container) out.containerChangeId = id;
      if (item) out.itemChangeId = id;
    }
    return out;
  }

  /**
   * `delete_changes`: keep the newest `keep` entries; the one before them
   * becomes the truncation marker and everything older goes.
   */
  truncate(keep: number): void {
    if (this.entries.length <= keep) return;
    const markerIndex = this.entries.length - keep - 1;
    const marker: LogEntry = { changeId: this.entries[markerIndex].changeId, marker: true, changes: [] };
    this.entries = [marker, ...this.entries.slice(markerIndex + 1)];
  }
}

/** The changes of one commit, as Stalwart's ChangeLogBuilder collects them. */
class PendingChanges {
  private readonly sets: Record<Side, Record<ChangeOp, Set<string>>> = {
    container: { insert: new Set(), update: new Set(), delete: new Set() },
    item: { insert: new Set(), update: new Set(), delete: new Set() },
  };

  insert(side: Side, id: string): void {
    const sets = this.sets[side];
    if (sets.delete.delete(id)) sets.update.add(id);
    else sets.insert.add(id);
  }

  update(side: Side, id: string): void {
    this.sets[side].update.add(id);
  }

  delete(side: Side, id: string): void {
    const sets = this.sets[side];
    sets.update.delete(id);
    sets.delete.add(id);
  }

  toChanges(): Change[] {
    const out: Change[] = [];
    for (const side of ['container', 'item'] as const) {
      for (const op of ['insert', 'update', 'delete'] as const) {
        for (const id of this.sets[side][op]) out.push({ side, op, id });
      }
    }
    return out;
  }
}

// ─── Normalisation ─────────────────────────────────────

/** RFC 3339 with offset → UTC at second precision with `Z`; null when unparsable. */
function utcSeconds(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A LocalDateTime at second precision; a fraction and any `Z` or offset are ignored. */
function localDateTime(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|z|[+-]\d{2}:?\d{2})?$/.exec(value);
  return match ? match[1] : null;
}

/**
 * `full` as calcard derives it when a name has components but no `full`
 * (written as `FN;DERIVED=TRUE` and read back as `name.full`): the
 * components in order joined by the default separator (a space unless
 * `defaultSeparator` says otherwise), `separator` components verbatim.
 */
function deriveFullName(name: Obj): string {
  if (!Array.isArray(name.components)) return '';
  const separator =
    typeof name.defaultSeparator === 'string' && name.defaultSeparator !== '' ? name.defaultSeparator : ' ';
  let full = '';
  let afterValue = false;
  for (const component of name.components) {
    if (!isObj(component) || typeof component.value !== 'string') continue;
    if (component.kind === 'separator') {
      full += component.value;
      afterValue = false;
    } else if (typeof component.kind === 'string' && NAME_KINDS.has(component.kind)) {
      if (afterValue) full += separator;
      full += component.value;
      afterValue = true;
    }
  }
  return full;
}

/** Components make a name or address ordered (JSCOMPS is always written); without them the flag goes. */
function normalizeOrdered(value: Obj): void {
  if (Array.isArray(value.components) && value.components.length > 0) {
    value.isOrdered = true;
  } else {
    delete value.isOrdered;
    if (Array.isArray(value.components)) delete value.components;
  }
}

function dropEmptyMaps(obj: Obj, maps: string[]): void {
  for (const key of maps) {
    const value = obj[key];
    if (isObj(value) && Object.keys(value).length === 0) delete obj[key];
  }
}

/**
 * A card as `ContactCard/get` returns it after Stalwart stored it as vCard:
 * `@type: "Card"` and `version: "1.0"` always (verified); `isOrdered: true`
 * on a name and on addresses with components (verified); `kind: "title"` on
 * titles without a kind (verified); a derived `name.full` when absent, which
 * then sticks, since Stalwart never re-derives it after a component patch;
 * `@type` on anniversary dates; `created`/`updated` in UTC at second
 * precision; empty maps gone. `data:` URIs in media stay as sent (Stalwart
 * re-encodes them as `data:<type>;base64,…`, which the tests don't need).
 */
function normalizeCard(input: Obj): Obj {
  stripNulls(input);
  const card: Obj = { '@type': 'Card', version: '1.0' };
  for (const [key, value] of Object.entries(input)) {
    if (key !== '@type' && key !== 'version') setKey(card, key, value);
  }
  for (const key of ['created', 'updated']) {
    const value = card[key];
    if (typeof value !== 'string') continue;
    const utc = utcSeconds(value);
    if (utc) card[key] = utc;
    else delete card[key];
  }
  if (isObj(card.name)) {
    const name = card.name;
    normalizeOrdered(name);
    if (typeof name.full !== 'string') {
      const full = deriveFullName(name);
      if (full) name.full = full;
    }
  }
  if (isObj(card.addresses)) {
    for (const address of Object.values(card.addresses)) if (isObj(address)) normalizeOrdered(address);
  }
  if (isObj(card.titles)) {
    for (const title of Object.values(card.titles)) {
      if (isObj(title) && title.kind === undefined) title.kind = 'title';
    }
  }
  if (isObj(card.anniversaries)) {
    for (const anniversary of Object.values(card.anniversaries)) {
      if (!isObj(anniversary) || !isObj(anniversary.date) || anniversary.date['@type'] !== undefined) continue;
      const date = anniversary.date;
      if (date.utc !== undefined) date['@type'] = 'Timestamp';
      else if (date.year !== undefined || date.month !== undefined || date.day !== undefined) date['@type'] = 'PartialDate';
    }
  }
  dropEmptyMaps(card, CARD_MAPS);
  return card;
}

/** `@type` calcard puts on nested event objects. */
function addNestedTypes(component: Obj): void {
  const typed: Array<[string, string]> = [
    ['participants', 'Participant'],
    ['locations', 'Location'],
    ['virtualLocations', 'VirtualLocation'],
    ['links', 'Link'],
    ['alerts', 'Alert'],
  ];
  for (const [property, type] of typed) {
    const map = component[property];
    if (!isObj(map)) continue;
    for (const entry of Object.values(map)) {
      if (!isObj(entry)) continue;
      if (entry['@type'] === undefined) entry['@type'] = type;
      const trigger = entry.trigger;
      if (property === 'alerts' && isObj(trigger) && trigger['@type'] === undefined) {
        if (trigger.offset !== undefined) trigger['@type'] = 'OffsetTrigger';
        else if (trigger.when !== undefined) trigger['@type'] = 'AbsoluteTrigger';
      }
    }
  }
}

function normalizeEventTimes(component: Obj): void {
  if (typeof component.start === 'string') {
    const start = localDateTime(component.start);
    if (start) component.start = start;
  }
  if (typeof component.created === 'string') {
    const created = localDateTime(component.created);
    if (created) component.created = `${created}Z`;
  }
}

/**
 * An event as `CalendarEvent/get` returns it after Stalwart stored it as
 * iCalendar:
 * - `updated` is the server's time on every write (verified), and every
 *   override stored as its own VEVENT gets one too (verified for new and
 *   changed overrides; `stamp_updated` stamps all of them). In `server` mode
 *   (seeds, edits by another client) an `updated` that is already there is
 *   kept, so tests can pin it.
 * - `@type` defaults to `Event` (`Task` stays); participants, locations,
 *   virtual locations, links and alerts get their `@type`.
 * - `start` and override keys are LocalDateTimes (a fraction, `Z` or offset
 *   is ignored); an override key that is not one is dropped, `{excluded:
 *   true}` loses everything else, forbidden override properties go, and a
 *   stricter override `privacy` raises the event's.
 * - Empty maps are gone.
 */
function normalizeEvent(input: Obj, now: string, mode: 'jmap' | 'server'): Obj {
  stripNulls(input);
  const event: Obj = { '@type': typeof input['@type'] === 'string' ? input['@type'] : 'Event' };
  for (const [key, value] of Object.entries(input)) if (key !== '@type') setKey(event, key, value);
  normalizeEventTimes(event);
  addNestedTypes(event);
  if (isObj(event.recurrenceOverrides)) {
    const overrides: Obj = {};
    let privacy = Math.max(0, PRIVACY_RANK.indexOf(String(event.privacy)));
    for (const [key, value] of Object.entries(event.recurrenceOverrides)) {
      const rid = localDateTime(key);
      if (!rid || !isObj(value)) continue;
      if (value.excluded === true) {
        setKey(overrides, rid, { excluded: true });
        continue;
      }
      privacy = Math.max(privacy, PRIVACY_RANK.indexOf(String(value.privacy)));
      for (const forbidden of FORBIDDEN_OVERRIDE_PROPERTIES) delete value[forbidden];
      // Stored as a VEVENT of its own: an empty map writes nothing there either.
      dropEmptyMaps(value, EVENT_MAPS);
      if (Object.keys(value).length > 0) {
        normalizeEventTimes(value);
        addNestedTypes(value);
        if (mode === 'jmap' || typeof value.updated !== 'string') value.updated = now;
      }
      setKey(overrides, rid, value);
    }
    event.recurrenceOverrides = overrides;
    if (privacy > 0 && privacy > PRIVACY_RANK.indexOf(String(event.privacy))) event.privacy = PRIVACY_RANK[privacy];
  }
  if (mode === 'jmap' || typeof event.updated !== 'string') event.updated = now;
  dropEmptyMaps(event, EVENT_MAPS);
  return event;
}

// ─── Positional re-keying ──────────────────────────────

interface Rekeyed {
  map: Obj;
  renames: Record<string, string>;
}

function rekeyMap(map: Obj, keyFor: (entry: unknown, index: number, oldKey: string) => string): Rekeyed {
  const out: Obj = {};
  const renames: Record<string, string> = {};
  Object.entries(map).forEach(([oldKey, entry], index) => {
    let key = keyFor(entry, index, oldKey);
    // jmap-tools renames a colliding key to `<key>-<n>` (json/object_vec.rs).
    for (let n = 2; hasOwn(out, key); n++) key = `${keyFor(entry, index, oldKey)}-${n}`;
    setKey(out, key, entry);
    renames[oldKey] = key;
  });
  return { map: out, renames };
}

const positional = (_entry: unknown, index: number) => `k${index + 1}`;

function byContent(property: string): (entry: unknown, index: number, oldKey: string) => string {
  return (entry, _index, oldKey) => {
    const content = isObj(entry) ? entry[property] : undefined;
    return typeof content === 'string' ? uuid5(content) : oldKey;
  };
}

/** Card maps keyed by PROP-ID get `k1…kN` by position; titles follow their organization. */
function rekeyCard(card: Obj): void {
  let organizations: Record<string, string> = {};
  for (const property of CARD_KEYED_MAPS) {
    const map = card[property];
    if (!isObj(map)) continue;
    const rekeyed = rekeyMap(map, positional);
    card[property] = rekeyed.map;
    if (property === 'organizations') organizations = rekeyed.renames;
  }
  if (isObj(card.speakToAs) && isObj(card.speakToAs.pronouns)) {
    card.speakToAs.pronouns = rekeyMap(card.speakToAs.pronouns, positional).map;
  }
  if (isObj(card.titles)) {
    for (const title of Object.values(card.titles)) {
      if (isObj(title) && typeof title.organizationId === 'string' && organizations[title.organizationId]) {
        title.organizationId = organizations[title.organizationId];
      }
    }
  }
}

/**
 * Alerts get `k1…kN` by position; participants, locations, virtual locations
 * and links get uuid5 of their calendar address, name, uri and href.
 */
function rekeyEventComponent(component: Obj): void {
  if (isObj(component.alerts)) component.alerts = rekeyMap(component.alerts, positional).map;
  if (isObj(component.participants)) component.participants = rekeyMap(component.participants, byContent('calendarAddress')).map;
  if (isObj(component.virtualLocations)) component.virtualLocations = rekeyMap(component.virtualLocations, byContent('uri')).map;
  if (isObj(component.links)) component.links = rekeyMap(component.links, byContent('href')).map;
  if (!isObj(component.locations)) return;
  const locations = rekeyMap(component.locations, (entry, index, oldKey) => {
    const name = isObj(entry) ? entry.name ?? entry.coordinates : undefined;
    return typeof name === 'string' ? uuid5(name) : oldKey;
  });
  component.locations = locations.map;
  if (typeof component.mainLocationId === 'string' && locations.renames[component.mainLocationId]) {
    component.mainLocationId = locations.renames[component.mainLocationId];
  }
  if (isObj(component.participants)) {
    for (const participant of Object.values(component.participants)) {
      if (isObj(participant) && typeof participant.locationId === 'string' && locations.renames[participant.locationId]) {
        participant.locationId = locations.renames[participant.locationId];
      }
    }
  }
}

function rekeyEvent(event: Obj): void {
  rekeyEventComponent(event);
  if (isObj(event.recurrenceOverrides)) {
    for (const override of Object.values(event.recurrenceOverrides)) if (isObj(override)) rekeyEventComponent(override);
  }
}

// ─── Server model ──────────────────────────────────────

interface Stored {
  id: string;
  /** Document id: creation order, the order `/query` and `ids: null` return. */
  docId: number;
  /** The JSContact/JSCalendar (or container) properties, without id, parents and JMAP-only flags. */
  data: Obj;
  /** addressBookIds / calendarIds, in order. */
  parents: string[];
  /** Events: isDraft, useDefaultAlerts, mayInviteSelf, mayInviteOthers, hideAttendees. */
  flags: Obj;
  /** First request whose `uid` query finds the object (the index lags). */
  uidVisibleFrom: number;
  modSeq: number;
}

interface Account {
  id: string;
  name: string;
  isPersonal: boolean;
  isReadOnly: boolean;
  contacts: boolean;
  calendars: boolean;
  addresses: string[];
  /** Change ids are global to the account. */
  lastChangeId: number;
  logs: Record<TypeGroup, ChangeLog>;
  objects: Record<DataType, Map<string, Stored>>;
  usedIds: Record<DataType, Set<string>>;
  idCounter: Record<DataType, number>;
  docCounter: Record<DataType, number>;
  defaultContainer: Partial<Record<ContainerType, string>>;
  blobs: Map<string, { bytes: Uint8Array; type: string }>;
}

interface Draft {
  data: Obj;
  parents: string[];
  flags: Obj;
}

interface Fault {
  kind: FaultKind;
  target: 'request' | 'download';
  applied: boolean;
  retryAfterMs: number;
  remaining: number;
  match?: (calls: JmapInvocation[]) => boolean;
}

interface InjectedSetError {
  type: ItemType;
  accountId: string;
  match: (target: SetTarget) => boolean;
  error: SetErrorShape;
  remaining: number;
}

interface InjectedMethodError {
  method: string;
  accountId?: string;
  error: { type: string; description?: string };
  remaining: number;
}

interface CallContext {
  seq: number;
  /** Arguments that came from result references. */
  references: Set<string>;
}

function groupOf(type: DataType): TypeGroup {
  return type === 'AddressBook' || type === 'ContactCard' ? 'contacts' : 'calendars';
}

function isContainer(type: DataType): type is ContainerType {
  return type === 'AddressBook' || type === 'Calendar';
}

function containerOf(type: ItemType): ContainerType {
  return type === 'ContactCard' ? 'AddressBook' : 'Calendar';
}

function parentProperty(type: ItemType): string {
  return type === 'ContactCard' ? 'addressBookIds' : 'calendarIds';
}

function sideOf(type: DataType): Side {
  return isContainer(type) ? 'container' : 'item';
}

function transportError(fault: Fault): Error & { retryAfterMs?: number } {
  const [name, message] = {
    network: ['NetworkError', 'Network request failed'],
    timeout: ['RequestTimeoutError', 'Request timed out after 30s'],
    auth: ['AuthenticationError', 'Session expired'],
    rateLimit: ['RateLimitError', 'Rate limited by server'],
  }[fault.kind];
  const error: Error & { retryAfterMs?: number } = new Error(message);
  error.name = name;
  if (fault.kind === 'rateLimit') error.retryAfterMs = fault.retryAfterMs;
  return error;
}

/** What jmap-client.ts throws for Stalwart's HTTP 400 request-level limit error. */
function limitError(limit: string, detail: string): Error {
  const body = JSON.stringify({ type: 'urn:ietf:params:jmap:error:limit', status: 400, limit, detail });
  return new Error(`JMAP request failed: 400 - ${body}`);
}

// ─── The server ────────────────────────────────────────

export class FakeJmapServer {
  /** Every request, in order, with its calls and what the server answered. */
  readonly requests: RequestRecord[] = [];
  /** `/set` changes made with `sendSchedulingMessages: true` (no message is sent). */
  readonly scheduling: SchedulingRecord[] = [];
  /** Blob downloads, in order. */
  readonly downloads: Array<{ accountId: string; blobId: string }> = [];
  /** The most requests that were in flight at once (the engine keeps one per run). */
  maxInFlight = 0;
  private inFlight = 0;

  private readonly accounts = new Map<string, Account>();
  private limits: FakeLimits;
  private readonly customClock: (() => number) | null;
  private manualTime: number;
  private requestSeq = 0;
  private uidLag = 0;
  private uidCounter = 0;
  private blobCounter = 0;
  private modSeq = 0;
  private sessionVersion = 0;
  private faults: Fault[] = [];
  private setErrors: InjectedSetError[] = [];
  private methodErrors: InjectedMethodError[] = [];
  private readonly beforeListeners = new Set<RequestListener>();
  private readonly afterListeners = new Set<RequestListener>();

  constructor(options: FakeJmapServerOptions = {}) {
    this.customClock = options.now ?? null;
    this.manualTime = options.startTime ?? Date.UTC(2026, 0, 1);
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  // ── Clock ──

  now(): number {
    return this.customClock ? this.customClock() : this.manualTime;
  }

  setTime(ms: number): void {
    if (this.customClock) throw new Error('fake server: the clock was injected; move it instead');
    this.manualTime = ms;
  }

  advanceTime(ms: number): void {
    this.setTime(this.manualTime + ms);
  }

  private nowUtc(): string {
    return new Date(this.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  // ── Accounts and the port ──

  addAccount(id: string, options: AccountOptions): void {
    if (!ID_PATTERN.test(id)) throw new Error(`fake server: invalid account id ${id}`);
    if (this.accounts.has(id)) throw new Error(`fake server: account ${id} exists`);
    const capabilities = options.capabilities ?? ['contacts', 'calendars'];
    const perType = <T>(make: () => T): Record<DataType, T> => ({
      AddressBook: make(),
      ContactCard: make(),
      Calendar: make(),
      CalendarEvent: make(),
    });
    this.accounts.set(id, {
      id,
      name: options.name,
      isPersonal: options.isPersonal ?? true,
      isReadOnly: options.isReadOnly ?? false,
      contacts: capabilities.includes('contacts'),
      calendars: capabilities.includes('calendars'),
      addresses: options.addresses ?? (options.name.includes('@') ? [options.name] : []),
      lastChangeId: 0,
      logs: { contacts: new ChangeLog(), calendars: new ChangeLog() },
      objects: perType(() => new Map<string, Stored>()),
      usedIds: perType(() => new Set<string>()),
      idCounter: perType(() => 0),
      docCounter: perType(() => 0),
      defaultContainer: {},
      blobs: new Map(),
    });
    this.sessionVersion++;
  }

  /**
   * The engine's view of the server. `username` is the session's login
   * (default: the first personal account's name); the primary account of a
   * capability is the personal account named like it, else the first
   * personal one that has the capability.
   */
  port(username?: string): JmapPort {
    return {
      session: () => this.sessionView(username),
      limits: () => ({
        maxObjectsInGet: this.limits.maxObjectsInGet,
        maxObjectsInSet: this.limits.maxObjectsInSet,
        maxCallsInRequest: this.limits.maxCallsInRequest,
        maxConcurrentRequests: 4,
        maxSizeRequest: this.limits.maxSizeRequest,
      }),
      request: (calls, using) => this.handleRequest(calls, using),
      downloadBlob: (accountId, blobId) => this.handleDownload(accountId, blobId),
    };
  }

  private sessionView(username?: string): JmapSessionView {
    const accounts: Record<string, JmapAccountView> = {};
    const all = [...this.accounts.values()];
    const personal = all.filter((a) => a.isPersonal);
    const login = username ?? personal[0]?.name ?? '';
    const preferred = [...personal.filter((a) => a.name === login), ...personal.filter((a) => a.name !== login)];
    const primaryAccounts: Record<string, string> = {};
    const contactsPrimary = preferred.find((a) => a.contacts);
    const calendarsPrimary = preferred.find((a) => a.calendars);
    if (contactsPrimary) primaryAccounts[JMAP_CONTACTS] = contactsPrimary.id;
    if (calendarsPrimary) primaryAccounts[JMAP_CALENDARS] = calendarsPrimary.id;
    for (const account of all) {
      const accountCapabilities: Record<string, unknown> = {};
      if (account.contacts) {
        accountCapabilities[JMAP_CONTACTS] = { maxAddressBooksPerCard: null, mayCreateAddressBook: !account.isReadOnly };
      }
      if (account.calendars) {
        accountCapabilities[JMAP_CALENDARS] = {
          maxCalendarsPerEvent: null,
          minDateTime: '0001-01-01T00:00:00Z',
          maxDateTime: '9999-12-31T23:59:59Z',
          maxExpandedQueryDuration: 'P52W1D',
          maxParticipantsPerEvent: 20,
          mayCreateCalendar: !account.isReadOnly,
        };
      }
      accounts[account.id] = {
        name: account.name,
        isPersonal: account.isPersonal,
        isReadOnly: account.isReadOnly,
        accountCapabilities,
      };
    }
    const capabilities: Record<string, unknown> = {
      [JMAP_CORE]: {
        maxSizeUpload: 50_000_000,
        maxConcurrentUpload: 4,
        maxSizeRequest: this.limits.maxSizeRequest,
        maxConcurrentRequests: 4,
        maxCallsInRequest: this.limits.maxCallsInRequest,
        maxObjectsInGet: this.limits.maxObjectsInGet,
        maxObjectsInSet: this.limits.maxObjectsInSet,
        collationAlgorithms: [],
      },
    };
    if (all.some((a) => a.contacts)) capabilities[JMAP_CONTACTS] = {};
    if (all.some((a) => a.calendars)) capabilities[JMAP_CALENDARS] = {};
    return { username: login, accounts, primaryAccounts, capabilities };
  }

  // ── Seeds and edits by another client ──
  // Each call is one commit, so it shows up in `/changes` like any server-side
  // change. Like a DAV client they skip the JMAP checks (uid uniqueness,
  // rights) and get neither the organizer nor the default alerts a JMAP
  // create adds; otherwise objects are normalised as Stalwart returns them.

  addAddressBook(accountId: string, book: Obj & { name: string }): string {
    return this.insertContainer('AddressBook', accountId, book);
  }

  addCalendar(accountId: string, calendar: Obj & { name: string }): string {
    return this.insertContainer('Calendar', accountId, calendar);
  }

  /** `addressBookIds` defaults to the default address book. */
  addCard(accountId: string, card: Obj = {}): string {
    return this.insertItem('ContactCard', accountId, card);
  }

  /** `calendarIds` defaults to the default calendar; `updated` is stamped unless given. */
  addEvent(accountId: string, event: Obj = {}): string {
    return this.insertItem('CalendarEvent', accountId, event);
  }

  serverCreate(type: DataType, accountId: string, object: Obj): string {
    return isContainer(type)
      ? this.insertContainer(type, accountId, object)
      : this.insertItem(type, accountId, object);
  }

  /**
   * Another client patches an object (PatchObject keys, JSON Pointers
   * included). Events get `updated` stamped unless the patch sets it.
   */
  serverUpdate(type: DataType, accountId: string, id: string, patch: Obj): void {
    const account = this.requireAccount(accountId);
    const stored = this.requireObject(account, type, id);
    const pending = new PendingChanges();
    if (isContainer(type)) {
      const data = clone(stored.data);
      for (const [key, value] of Object.entries(clone(patch))) {
        if (key === 'id') continue;
        if (key === 'isDefault') {
          if (value === true) account.defaultContainer[type] = id;
          continue;
        }
        if (key.includes('/')) {
          if (!applyPointer(data, parsePointer(key), value)) throw new Error(`fake server: patch ${key} failed`);
        } else {
          assignOrDelete(data, key, value);
        }
      }
      stored.data = data;
      pending.update('container', id);
    } else {
      const draft: Draft = { data: clone(stored.data), parents: [...stored.parents], flags: { ...stored.flags } };
      const error = this.applyItemProperties(type, draft, clone(patch), id);
      if (error) throw new Error(`fake server: ${error.type} ${error.properties?.join(',') ?? ''} ${error.description ?? ''}`);
      for (const parent of draft.parents) this.requireObject(account, containerOf(type), parent);
      if (type === 'ContactCard') {
        draft.data = normalizeCard(draft.data);
      } else {
        const keepUpdated = hasOwn(patch, 'updated');
        if (!keepUpdated) delete draft.data.updated;
        draft.data = normalizeEvent(draft.data, this.nowUtc(), 'server');
      }
      Object.assign(stored, draft);
      pending.update('item', id);
    }
    stored.modSeq = ++this.modSeq;
    this.commit(account, groupOf(type), pending);
  }

  /**
   * Another client deletes an object. A container takes its items along, as
   * `onDestroyRemoveContents` does: items only in it are destroyed, items in
   * other containers too just lose the membership.
   */
  serverDestroy(type: DataType, accountId: string, id: string): void {
    const account = this.requireAccount(accountId);
    this.requireObject(account, type, id);
    const pending = new PendingChanges();
    account.objects[type].delete(id);
    pending.delete(sideOf(type), id);
    if (isContainer(type)) {
      if (account.defaultContainer[type] === id) delete account.defaultContainer[type];
      const itemType: ItemType = type === 'AddressBook' ? 'ContactCard' : 'CalendarEvent';
      for (const item of [...account.objects[itemType].values()]) {
        if (!item.parents.includes(id)) continue;
        item.parents = item.parents.filter((p) => p !== id);
        if (item.parents.length === 0) {
          account.objects[itemType].delete(item.id);
          pending.delete('item', item.id);
        } else {
          item.modSeq = ++this.modSeq;
          pending.update('item', item.id);
        }
      }
    }
    this.commit(account, groupOf(type), pending);
  }

  /**
   * Rewrite a card's or event's map keys as Stalwart generates them for an
   * object written over CardDAV/CalDAV without PROP-IDs/JSIDs: `k1…kN` by
   * position for card entries and alerts, uuid5 of the address, name, uri or
   * href for participants, locations, virtual locations and links. Logged
   * as an update; nothing else changes (no `updated` stamp).
   */
  rekeyPositionally(accountId: string, id: string, type?: ItemType): void {
    const account = this.requireAccount(accountId);
    const inCards = account.objects.ContactCard.has(id);
    const inEvents = account.objects.CalendarEvent.has(id);
    if (!type && inCards && inEvents) throw new Error(`fake server: ${id} is both a card and an event; pass the type`);
    const resolved: ItemType | undefined = type ?? (inCards ? 'ContactCard' : inEvents ? 'CalendarEvent' : undefined);
    if (!resolved) throw new Error(`fake server: no card or event ${id} in ${accountId}`);
    const stored = this.requireObject(account, resolved, id);
    if (resolved === 'ContactCard') rekeyCard(stored.data);
    else rekeyEvent(stored.data);
    stored.modSeq = ++this.modSeq;
    const pending = new PendingChanges();
    pending.update('item', id);
    this.commit(account, groupOf(resolved), pending);
  }

  /** Store a blob for `downloadBlob` (e.g. a blob-backed `media` entry). */
  addBlob(accountId: string, data: Uint8Array | string, type = 'application/octet-stream'): string {
    const account = this.requireAccount(accountId);
    const blobId = `blob${++this.blobCounter}`;
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data.slice();
    account.blobs.set(blobId, { bytes, type });
    return blobId;
  }

  // ── Fault injection ──

  /**
   * The next request (matching `opts.match`) throws the transport error
   * jmap-client.ts would: NetworkError, RequestTimeoutError,
   * AuthenticationError or RateLimitError with `retryAfterMs`. By default
   * nothing of it runs; with `applied` it runs first (a lost response).
   */
  failNextRequest(kind: FaultKind, opts: FaultOptions = {}): void {
    this.faults.push(this.makeFault(kind, 'request', opts));
  }

  /** The next request runs (its writes are applied), then the response is lost: NetworkError. */
  applyThenLoseResponse(opts: Omit<FaultOptions, 'applied'> = {}): void {
    this.failNextRequest('network', { ...opts, applied: true });
  }

  /** The next blob download throws the transport error for `kind`. */
  failNextDownload(kind: FaultKind, opts: Omit<FaultOptions, 'applied' | 'match'> = {}): void {
    this.faults.push(this.makeFault(kind, 'download', opts));
  }

  /** The next call of `method` (for `accountId`, if given) answers with this method-level error. */
  failNextMethod(
    method: string,
    error: { type: string; description?: string },
    opts: { accountId?: string; times?: number } = {},
  ): void {
    this.methodErrors.push({ method, accountId: opts.accountId, error, remaining: opts.times ?? 1 });
  }

  /**
   * The next `/set` touching `id` answers with `error` for that object (and
   * applies nothing of it). `id` matches an update or destroy target, a
   * creation id, or the `uid` of a create; or pass a predicate.
   */
  setErrorFor(
    type: ItemType,
    accountId: string,
    id: string | ((target: SetTarget) => boolean),
    error: SetErrorShape,
    times = 1,
  ): void {
    const match =
      typeof id === 'function'
        ? id
        : (target: SetTarget) =>
            target.id === id || (target.op === 'create' && target.object?.uid === id);
    this.setErrors.push({ type, accountId, match, error, remaining: times });
  }

  /**
   * Trim the change log as Stalwart's daily purge does: keep the newest
   * `keep` commits, mark the one before them as truncated, drop the rest.
   * `/changes` from an older state then fails with `cannotCalculateChanges`.
   */
  truncateChangeLog(accountId: string, group: TypeGroup | DataType, keep = 0): void {
    const account = this.requireAccount(accountId);
    const key: TypeGroup = group === 'contacts' || group === 'calendars' ? group : groupOf(group);
    account.logs[key].truncate(keep);
  }

  /**
   * The `uid` query filter reads an index built after commit. With a lag of
   * `n`, an object created during request R (or between R and R+1) is found
   * by `uid` from request R+n+1 on. Applies to objects created afterwards.
   */
  setUidIndexLag(n: number): void {
    this.uidLag = Math.max(0, Math.floor(n));
  }

  setLimits(limits: Partial<FakeLimits>): void {
    this.limits = { ...this.limits, ...limits };
  }

  /** Runs when a request arrives, before anything of it runs (e.g. a concurrent server edit). */
  onBeforeRequest(listener: RequestListener): () => void {
    this.beforeListeners.add(listener);
    return () => this.beforeListeners.delete(listener);
  }

  /** Runs after a request ran, before its response reaches the caller (e.g. a device edit mid-upload). */
  onAfterRequest(listener: RequestListener): () => void {
    this.afterListeners.add(listener);
    return () => this.afterListeners.delete(listener);
  }

  // ── Introspection ──

  /** Everything the server holds for an object: properties, parents and flags. */
  get(type: DataType, accountId: string, id: string): Obj | undefined {
    const account = this.accounts.get(accountId);
    const stored = account?.objects[type].get(id);
    return account && stored ? this.snapshot(type, account, stored) : undefined;
  }

  all(type: DataType, accountId: string): Obj[] {
    const account = this.requireAccount(accountId);
    return [...account.objects[type].values()].map((stored) => this.snapshot(type, account, stored));
  }

  state(type: DataType, accountId: string): string {
    return this.stateOf(this.requireAccount(accountId), type);
  }

  /** Method calls sent so far, in order; only those named `name` when given. */
  calls(name?: string): JmapInvocation[] {
    const all = this.requests.flatMap((r) => r.calls);
    return name ? all.filter(([method]) => method === name) : all;
  }

  // ── Requests ──

  private async handleRequest(calls: JmapInvocation[], using: string[]): Promise<JmapResponse> {
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      // Yield like a round trip, so requests a caller does not await overlap.
      await Promise.resolve();
      return await this.runRequest(calls, using);
    } finally {
      this.inFlight--;
    }
  }

  private async runRequest(calls: JmapInvocation[], using: string[]): Promise<JmapResponse> {
    const seq = ++this.requestSeq;
    const record: RequestRecord = {
      seq,
      using: [...using],
      calls: clone(calls),
      methods: calls.map(([name]) => name),
      responses: null,
      outcome: 'ok',
    };
    this.requests.push(record);
    for (const listener of this.beforeListeners) await listener(record);
    const fault = this.takeFault('request', calls);
    if (fault && !fault.applied) {
      record.outcome = 'failed';
      record.fault = fault.kind;
      throw transportError(fault);
    }
    if (calls.length > this.limits.maxCallsInRequest) {
      record.outcome = 'rejected';
      throw limitError('maxCallsInRequest', 'The request exceeds the maximum number of calls in a single request.');
    }
    const size = new TextEncoder().encode(JSON.stringify({ using, methodCalls: calls })).length;
    if (size > this.limits.maxSizeRequest) {
      record.outcome = 'rejected';
      throw limitError('maxSizeRequest', 'The request is larger than the server is willing to process.');
    }
    const responses: JmapInvocation[] = [];
    for (const call of clone(calls)) responses.push(this.executeCall(call, using, responses, seq));
    record.responses = clone(responses);
    for (const listener of this.afterListeners) await listener(record);
    if (fault) {
      record.outcome = 'lost';
      record.fault = fault.kind;
      throw transportError(fault);
    }
    return { methodResponses: responses, sessionState: `fs${this.sessionVersion}` };
  }

  private async handleDownload(accountId: string, blobId: string): Promise<Uint8Array> {
    this.downloads.push({ accountId, blobId });
    const fault = this.takeFault('download', null);
    if (fault) throw transportError(fault);
    const blob = this.accounts.get(accountId)?.blobs.get(blobId);
    if (!blob) throw new Error('Failed to fetch blob: 404');
    return blob.bytes.slice();
  }

  private makeFault(kind: FaultKind, target: Fault['target'], opts: FaultOptions): Fault {
    const match = opts.match;
    return {
      kind,
      target,
      applied: opts.applied ?? false,
      retryAfterMs: opts.retryAfterMs ?? 1000,
      remaining: opts.times ?? 1,
      match:
        typeof match === 'string'
          ? (calls: JmapInvocation[]) => calls.some(([name]) => name === match)
          : match,
    };
  }

  private takeFault(target: Fault['target'], calls: JmapInvocation[] | null): Fault | null {
    const index = this.faults.findIndex(
      (f) => f.target === target && (!f.match || (calls !== null && f.match(calls))),
    );
    if (index < 0) return null;
    const fault = this.faults[index];
    if (--fault.remaining <= 0) this.faults.splice(index, 1);
    return fault;
  }

  private executeCall(
    call: JmapInvocation,
    using: string[],
    prior: JmapInvocation[],
    seq: number,
  ): JmapInvocation {
    const [name, rawArgs, callId] = call;
    try {
      if (!SUPPORTED_METHODS.has(name)) {
        throw new MethodError('unknownMethod', `fake server: ${name} is not emulated`);
      }
      if (!isObj(rawArgs)) throw new MethodError('invalidArguments');
      const { args, references } = this.resolveReferences(rawArgs, prior);
      const capability = CAPABILITY_OF[name.split('/')[0]];
      if (!using.includes(capability)) {
        throw new MethodError(
          'unknownMethod',
          `Method ${name} requires capability ${capability} which is not present in the "using" property.`,
        );
      }
      const injected = this.takeMethodError(name, args.accountId);
      if (injected) throw new MethodError(injected.type, injected.description);
      return [name, this.dispatch(name, args, { seq, references }), callId];
    } catch (err) {
      if (!(err instanceof MethodError)) throw err;
      return ['error', err.detail ? { type: err.type, description: err.detail } : { type: err.type }, callId];
    }
  }

  private resolveReferences(raw: Obj, prior: JmapInvocation[]): { args: Obj; references: Set<string> } {
    const args: Obj = {};
    const references = new Set<string>();
    for (const [key, value] of Object.entries(raw)) if (!key.startsWith('#')) setKey(args, key, value);
    for (const [key, ref] of Object.entries(raw)) {
      if (!key.startsWith('#')) continue;
      const target = key.slice(1);
      if (hasOwn(args, target)) throw new MethodError('invalidArguments', `Both ${target} and ${key} are given.`);
      if (!isObj(ref) || typeof ref.resultOf !== 'string' || typeof ref.name !== 'string' || typeof ref.path !== 'string') {
        throw new MethodError('invalidArguments', `Invalid result reference in ${key}.`);
      }
      // Stalwart resolves references to /get, /changes, /query and
      // /queryChanges responses only; one to a /set is not found (verified).
      const notFound = new MethodError('invalidResultReference', `Result reference to ${ref.resultOf}#${ref.name} not found.`);
      const source = prior.find(([name, , id]) => id === ref.resultOf && name === ref.name);
      if (!source || !REFERENCEABLE.test(source[0])) throw notFound;
      const resolved = resolveReferencePath(source[1], ref.path);
      if (!resolved) throw notFound;
      setKey(args, target, clone(resolved.value));
      references.add(target);
    }
    return { args, references };
  }

  private takeMethodError(method: string, accountId: unknown): { type: string; description?: string } | null {
    const index = this.methodErrors.findIndex(
      (e) => e.method === method && (e.accountId === undefined || e.accountId === accountId),
    );
    if (index < 0) return null;
    const injected = this.methodErrors[index];
    if (--injected.remaining <= 0) this.methodErrors.splice(index, 1);
    return injected.error;
  }

  private dispatch(name: string, args: Obj, ctx: CallContext): Obj {
    if (name === 'Core/echo') return args;
    const [object, verb] = name.split('/') as [DataType, string];
    const account = this.methodAccount(args, object);
    switch (verb) {
      case 'get':
        return this.methodGet(object, account, args);
      case 'changes':
        return this.methodChanges(object, account, args);
      case 'query':
        return this.methodQuery(object as ItemType, account, args, ctx);
      case 'set':
        return this.methodSet(object as ItemType, account, args, ctx);
      default:
        throw new MethodError('unknownMethod');
    }
  }

  private methodAccount(args: Obj, type: DataType): Account {
    if (typeof args.accountId !== 'string') throw new MethodError('invalidArguments', 'accountId is required.');
    const account = this.accounts.get(args.accountId);
    if (!account) throw new MethodError('accountNotFound');
    if (!(groupOf(type) === 'contacts' ? account.contacts : account.calendars)) {
      throw new MethodError('accountNotSupportedByMethod');
    }
    return account;
  }

  // ── /get ──

  private methodGet(type: DataType, account: Account, args: Obj): Obj {
    const { ids, properties } = args;
    if (ids != null && !Array.isArray(ids)) throw new MethodError('invalidArguments', 'ids must be an array or null.');
    if (properties != null && !Array.isArray(properties)) {
      throw new MethodError('invalidArguments', 'properties must be an array or null.');
    }
    if (Array.isArray(ids) && ids.length > this.limits.maxObjectsInGet) throw new MethodError('requestTooLarge');
    const store = account.objects[type];
    // `ids: null` silently returns only the first maxObjectsInGet objects (verified).
    const targets: unknown[] = Array.isArray(ids)
      ? ids
      : [...store.keys()].slice(0, this.limits.maxObjectsInGet);
    const list: Obj[] = [];
    const notFound: unknown[] = [];
    for (const id of targets) {
      const stored = typeof id === 'string' ? store.get(id) : undefined;
      if (stored) list.push(this.render(type, account, stored, properties as unknown[] | null | undefined));
      else notFound.push(id);
    }
    return { accountId: account.id, state: this.stateOf(account, type), list, notFound };
  }

  private render(type: DataType, account: Account, stored: Stored, properties: unknown[] | null | undefined): Obj {
    const listed = properties ? properties.filter((p): p is string => typeof p === 'string') : null;
    if (isContainer(type)) {
      const full: Obj = { id: stored.id, ...clone(stored.data), isDefault: this.defaultContainerId(account, type) === stored.id };
      if (!listed) return full;
      const out: Obj = { id: stored.id };
      for (const p of listed) setKey(out, p, hasOwn(full, p) ? full[p] : null);
      return out;
    }
    const data = clone(stored.data);
    if (type === 'ContactCard') {
      if (!listed) return { id: stored.id, addressBookIds: booleanSet(stored.parents), ...data };
      const out: Obj = { id: stored.id };
      for (const p of listed) {
        if (p === 'addressBookIds') out.addressBookIds = booleanSet(stored.parents);
        else if (hasOwn(data, p)) setKey(out, p, data[p]);
      }
      return out;
    }
    // CalendarEvent: with `properties: null` Stalwart returns the JSCalendar
    // properties plus only id, calendarIds, isDraft and isOrigin; the other
    // JMAP-only fields (useDefaultAlerts, …) need an explicit list (verified).
    const jmap: Obj = {
      calendarIds: booleanSet(stored.parents),
      isDraft: stored.flags.isDraft === true,
      isOrigin: this.isOrigin(account, stored.data),
      useDefaultAlerts: stored.flags.useDefaultAlerts === true,
      mayInviteSelf: stored.flags.mayInviteSelf === true,
      mayInviteOthers: stored.flags.mayInviteOthers === true,
      hideAttendees: stored.flags.hideAttendees === true,
      baseEventId: null,
    };
    if (!listed) {
      return { ...data, id: stored.id, calendarIds: jmap.calendarIds, isDraft: jmap.isDraft, isOrigin: jmap.isOrigin };
    }
    const out: Obj = { id: stored.id };
    for (const p of listed) {
      if (hasOwn(jmap, p)) setKey(out, p, jmap[p]);
      else if (hasOwn(data, p)) setKey(out, p, data[p]);
    }
    return out;
  }

  private snapshot(type: DataType, account: Account, stored: Stored): Obj {
    if (isContainer(type)) {
      return { id: stored.id, ...clone(stored.data), isDefault: this.defaultContainerId(account, type) === stored.id };
    }
    return {
      id: stored.id,
      [parentProperty(type)]: booleanSet(stored.parents),
      ...clone(stored.data),
      ...clone(stored.flags),
    };
  }

  private isOrigin(account: Account, data: Obj): boolean {
    const organizer = data.organizerCalendarAddress;
    if (typeof organizer !== 'string') return true;
    const address = organizer.replace(/^mailto:/i, '').toLowerCase();
    return account.addresses.some((a) => a.toLowerCase() === address);
  }

  // ── /changes ──

  /** jmap/src/changes/get.rs, step by step. */
  private methodChanges(type: DataType, account: Account, args: Obj): Obj {
    const since = args.sinceState;
    if (typeof since !== 'string') throw new MethodError('invalidArguments', 'sinceState is required.');
    const parsed = parseState(since);
    if (!parsed) throw new MethodError('invalidArguments', `Invalid state ${since}.`);
    const maxArg = args.maxChanges;
    if (maxArg != null && (typeof maxArg !== 'number' || !Number.isInteger(maxArg) || maxArg < 0)) {
      throw new MethodError('invalidArguments', 'maxChanges must be a positive integer.');
    }
    const max = Math.min(typeof maxArg === 'number' && maxArg > 0 ? maxArg : Infinity, this.limits.maxChanges);
    const side = sideOf(type);
    const log = account.logs[groupOf(type)];
    const response = {
      accountId: account.id,
      oldState: since,
      newState: 'n',
      hasMoreChanges: false,
      created: [] as string[],
      updated: [] as string[],
      destroyed: [] as string[],
    };
    let newState: ParsedState = { kind: 'initial' };
    let itemsSent = 0;
    let window: ChangeWindow;
    if (parsed.kind === 'initial') {
      window = log.query({ all: true });
      if (window.changes.size === 0 && window.fromChangeId === 0) return response;
    } else if (parsed.kind === 'exact') {
      const last = log.sideChangeId(side);
      newState = stateOfChangeId(last);
      if (last === parsed.id) return { ...response, newState: encodeState(newState) };
      window = log.query({ since: parsed.id });
    } else {
      window = log.query({ from: parsed.from, to: parsed.to });
      const total = [...window.changes.values()].filter((c) => c.side === side).length;
      if (parsed.sent >= total) window = log.query({ since: parsed.to });
      else itemsSent = parsed.sent;
    }
    if ((window.isTruncated || window.fromChangeId === 0) && parsed.kind !== 'initial') {
      throw new MethodError(
        'cannotCalculateChanges',
        window.isTruncated ? 'Change log is truncated' : 'Since state is invalid',
      );
    }
    const changes = [...window.changes.values()].filter((c) => c.side === side);
    for (const change of changes.slice(itemsSent, itemsSent + max)) {
      if (change.op === 'insert') response.created.push(change.id);
      else if (change.op === 'update') response.updated.push(change.id);
      else response.destroyed.push(change.id);
    }
    const changeId = (side === 'container' ? window.containerChangeId : window.itemChangeId) ?? window.toChangeId;
    response.hasMoreChanges = changes.length > itemsSent + max;
    if (response.hasMoreChanges) {
      newState = { kind: 'intermediate', from: window.fromChangeId, to: changeId, sent: itemsSent + max };
    } else if (newState.kind === 'initial') {
      newState = { kind: 'exact', id: changeId };
    }
    response.newState = encodeState(newState);
    return response;
  }

  // ── /query ──

  private methodQuery(type: ItemType, account: Account, args: Obj, ctx: CallContext): Obj {
    if (args.anchor != null) throw new MethodError('invalidArguments', 'fake server: anchor is not emulated');
    if (args.expandRecurrences === true) {
      throw new MethodError('invalidArguments', 'fake server: expandRecurrences is not emulated');
    }
    const inParent = type === 'ContactCard' ? 'inAddressBook' : 'inCalendar';
    const validate = (filter: unknown): void => {
      if (filter == null) return;
      if (!isObj(filter)) throw new MethodError('invalidArguments', 'filter must be an object.');
      if (filter.operator !== undefined) {
        if (!['AND', 'OR', 'NOT'].includes(String(filter.operator)) || !Array.isArray(filter.conditions)) {
          throw new MethodError('unsupportedFilter', `Invalid filter operator ${String(filter.operator)}.`);
        }
        filter.conditions.forEach(validate);
        return;
      }
      for (const key of Object.keys(filter)) {
        if (key !== inParent && key !== 'uid') {
          throw new MethodError('unsupportedFilter', `fake server: filter ${key} is not emulated`);
        }
      }
    };
    // `inAddressBook`/`inCalendar` read the synchronous cache; `uid` reads
    // the search index, which lags behind writes (verified).
    const matches = (stored: Stored, filter: unknown): boolean => {
      if (!isObj(filter)) return true;
      if (filter.operator !== undefined) {
        const conditions = filter.conditions as unknown[];
        if (filter.operator === 'AND') return conditions.every((c) => matches(stored, c));
        if (filter.operator === 'OR') return conditions.some((c) => matches(stored, c));
        return !conditions.some((c) => matches(stored, c));
      }
      if (filter[inParent] !== undefined && !stored.parents.includes(filter[inParent] as string)) return false;
      if (filter.uid !== undefined && (stored.data.uid !== filter.uid || stored.uidVisibleFrom > ctx.seq)) return false;
      return true;
    };
    validate(args.filter);
    let results = [...account.objects[type].values()].filter((stored) => matches(stored, args.filter));
    results = this.sortResults(type, results, args.sort);

    const total = results.length;
    const cap = this.limits.maxQueryResults;
    const requested = args.limit;
    if (requested != null && (typeof requested !== 'number' || requested < 0)) {
      throw new MethodError('invalidArguments', 'limit must be a positive integer.');
    }
    const limit = typeof requested === 'number' ? Math.min(requested, cap) : cap;
    const take = Math.min(limit, total);
    const position = typeof args.position === 'number' ? Math.trunc(args.position) : 0;
    let ids: string[];
    let responsePosition: number;
    if (position >= 0) {
      ids = results.slice(position, position + take).map((s) => s.id);
      responsePosition = position <= total ? position : 0;
    } else {
      const start = Math.max(0, total + position);
      ids = results.slice(start, start + take).map((s) => s.id);
      responsePosition = start;
    }
    const response: Obj = {
      accountId: account.id,
      queryState: this.stateOf(account, type),
      canCalculateChanges: true,
      position: responsePosition,
      ids,
    };
    if (args.calculateTotal === true) response.total = total;
    if (total > limit) response.limit = limit;
    return response;
  }

  private sortResults(type: ItemType, results: Stored[], sort: unknown): Stored[] {
    if (sort == null) return results;
    if (!Array.isArray(sort)) throw new MethodError('invalidArguments', 'sort must be an array.');
    const comparators = sort.map((comparator) => {
      const property = isObj(comparator) ? comparator.property : undefined;
      const ascending = !isObj(comparator) || comparator.isAscending !== false;
      const allowed = type === 'ContactCard' ? ['created', 'updated'] : ['start', 'recurrenceId', 'uid'];
      if (typeof property !== 'string' || !allowed.includes(property)) {
        throw new MethodError('unsupportedSort', String(property));
      }
      return (a: Stored, b: Stored): number => {
        let diff: number;
        if (property === 'created') diff = a.docId - b.docId;
        else if (property === 'updated') diff = a.modSeq - b.modSeq;
        else {
          const field = property === 'uid' ? 'uid' : 'start';
          diff = String(a.data[field] ?? '').localeCompare(String(b.data[field] ?? ''));
        }
        return ascending ? diff : -diff;
      };
    });
    return [...results].sort((a, b) => {
      for (const compare of comparators) {
        const diff = compare(a, b);
        if (diff !== 0) return diff;
      }
      return a.docId - b.docId;
    });
  }

  // ── /set ──

  private methodSet(type: ItemType, account: Account, args: Obj, ctx: CallContext): Obj {
    const create = args.create ?? null;
    const update = args.update ?? null;
    const destroy = args.destroy ?? null;
    if ((create !== null && !isObj(create)) || (update !== null && !isObj(update)) || (destroy !== null && !Array.isArray(destroy))) {
      throw new MethodError('invalidArguments');
    }
    const creates = Object.entries(create ?? {});
    const updates = Object.entries(update ?? {});
    const destroys = (destroy ?? []) as unknown[];
    // A destroy given as a result reference does not count (jmap-proto method/set.rs).
    const counted = creates.length + updates.length + (ctx.references.has('destroy') ? 0 : destroys.length);
    if (counted > this.limits.maxObjectsInSet) throw new MethodError('requestTooLarge');
    const oldState = this.stateOf(account, type);
    if (args.ifInState != null) {
      if (typeof args.ifInState !== 'string' || !parseState(args.ifInState)) {
        throw new MethodError('invalidArguments', 'Invalid ifInState.');
      }
      if (args.ifInState !== oldState) throw new MethodError('stateMismatch');
    }
    if (account.isReadOnly) throw new MethodError('accountReadOnly');

    const store = account.objects[type];
    const scheduling = type === 'CalendarEvent' && args.sendSchedulingMessages === true;
    const record = (op: SchedulingRecord['op'], id: string) => {
      if (scheduling) this.scheduling.push({ accountId: account.id, op, id, requestSeq: ctx.seq });
    };
    const pending = new PendingChanges();
    const createdInCall = new Set<string>();
    const willDestroy = new Set(destroys.filter((id): id is string => typeof id === 'string'));
    const created: Obj = {};
    const notCreated: Obj = {};
    const updated: Obj = {};
    const notUpdated: Obj = {};
    const destroyed: string[] = [];
    const notDestroyed: Obj = {};

    for (const [creationId, object] of creates) {
      const injected = this.takeSetError(type, account.id, {
        op: 'create',
        id: creationId,
        object: isObj(object) ? object : undefined,
      });
      if (injected) {
        notCreated[creationId] = injected;
        continue;
      }
      if (!isObj(object)) {
        notCreated[creationId] = { type: 'invalidProperties', description: 'Invalid object.' };
        continue;
      }
      const draft = this.prepareCreate(type, account, object, createdInCall);
      if ('error' in draft) {
        notCreated[creationId] = draft.error;
        continue;
      }
      const id = this.mintId(account, type);
      this.storeNew(account, type, id, draft);
      createdInCall.add(id);
      pending.insert('item', id);
      created[creationId] = { id };
      record('create', id);
    }

    for (const [id, patch] of updates) {
      if (willDestroy.has(id)) {
        notUpdated[id] = { type: 'willDestroy' };
        continue;
      }
      const injected = this.takeSetError(type, account.id, { op: 'update', id, object: isObj(patch) ? patch : undefined });
      if (injected) {
        notUpdated[id] = injected;
        continue;
      }
      const stored = store.get(id);
      if (!stored || createdInCall.has(id)) {
        notUpdated[id] = { type: 'notFound' };
        continue;
      }
      if (!isObj(patch)) {
        notUpdated[id] = { type: 'invalidPatch' };
        continue;
      }
      const draft = this.prepareUpdate(type, account, stored, patch);
      if ('error' in draft) {
        notUpdated[id] = draft.error;
        continue;
      }
      Object.assign(stored, draft);
      stored.modSeq = ++this.modSeq;
      pending.update('item', id);
      updated[id] = null;
      record('update', id);
    }

    for (const id of destroys) {
      const key = String(id);
      const injected = this.takeSetError(type, account.id, { op: 'destroy', id: key });
      if (injected) {
        notDestroyed[key] = injected;
        continue;
      }
      const stored = typeof id === 'string' ? store.get(id) : undefined;
      if (!stored || createdInCall.has(key)) {
        notDestroyed[key] = { type: 'notFound' };
        continue;
      }
      const denied = stored.parents.find((p) => !this.canWrite(account, containerOf(type), p));
      if (denied) {
        notDestroyed[key] = {
          type: 'forbidden',
          description:
            type === 'ContactCard'
              ? `You are not allowed to remove contacts from address book ${denied}.`
              : `You are not allowed to remove calendar events from calendar ${denied}.`,
        };
        continue;
      }
      store.delete(key);
      pending.delete('item', key);
      destroyed.push(key);
      record('destroy', key);
    }

    const changeId = this.commit(account, groupOf(type), pending);
    // Stalwart leaves empty maps and lists out of a /set response; creates
    // report only `{id}` and updates `null` (verified).
    const response: Obj = {
      accountId: account.id,
      oldState,
      newState: changeId === null ? oldState : encodeState({ kind: 'exact', id: changeId }),
    };
    if (Object.keys(created).length) response.created = created;
    if (Object.keys(updated).length) response.updated = updated;
    if (destroyed.length) response.destroyed = destroyed;
    if (Object.keys(notCreated).length) response.notCreated = notCreated;
    if (Object.keys(notUpdated).length) response.notUpdated = notUpdated;
    if (Object.keys(notDestroyed).length) response.notDestroyed = notDestroyed;
    return response;
  }

  private takeSetError(type: ItemType, accountId: string, target: SetTarget): SetErrorShape | null {
    const index = this.setErrors.findIndex((e) => e.type === type && e.accountId === accountId && e.match(target));
    if (index < 0) return null;
    const injected = this.setErrors[index];
    if (--injected.remaining <= 0) this.setErrors.splice(index, 1);
    return clone(injected.error);
  }

  /**
   * Apply a create object or PatchObject the way `update_contact_card` and
   * `update_calendar_event` do: keys with `/` are JSON Pointers (a missing
   * parent fails the patch, verified), parent ids take a whole map or
   * `<prop>/<id>: true|false|null`, unknown top-level names are invalid.
   */
  private applyItemProperties(type: ItemType, draft: Draft, props: Obj, expectedId: string | null): SetErrorShape | null {
    const parentProp = parentProperty(type);
    for (const [key, value] of Object.entries(props)) {
      if (key.includes('/')) {
        const segments = parsePointer(key);
        const first = segments[0];
        if (first?.kind === 'key' && first.key === parentProp) {
          const second = segments[1];
          const parentId = second?.kind === 'key' ? second.key : undefined;
          if (parentId === undefined || (value !== true && value !== false && value !== null)) {
            return invalidProperties([parentProp], `Invalid patch operation for ${parentProp}.`);
          }
          draft.parents = draft.parents.filter((p) => p !== parentId);
          if (value === true) draft.parents.push(parentId);
          continue;
        }
        if (!applyPointer(draft.data, segments, value)) return invalidProperties([key], 'Patch operation failed.');
        continue;
      }
      if (key === parentProp) {
        if (!isObj(value)) return invalidProperties([parentProp], `Invalid patch operation for ${parentProp}.`);
        const next = Object.keys(value).filter((id) => value[id] === true);
        draft.parents = [...draft.parents.filter((p) => next.includes(p)), ...next.filter((p) => !draft.parents.includes(p))];
        continue;
      }
      if (key === 'id') {
        if (expectedId === null || value !== expectedId) {
          return invalidProperties(['id'], type === 'ContactCard' ? 'The id property is immutable.' : 'This property is immutable.');
        }
        continue;
      }
      if (type === 'CalendarEvent') {
        if (IMMUTABLE_EVENT_PROPERTIES.has(key)) return invalidProperties([key], 'This property is immutable.');
        if (EVENT_FLAGS.includes(key)) {
          if (typeof value !== 'boolean') return invalidProperties([key], 'Invalid value.');
          draft.flags[key] = value;
          continue;
        }
        if (key === 'utcStart' || key === 'utcEnd') {
          return invalidProperties([key], 'fake server: utcStart/utcEnd writes are not emulated');
        }
        if ((key === 'participants' || key === 'locations') && isObj(value) && Object.values(value).some(hasBlobLink)) {
          return invalidProperties([key], 'blobIds in links is not supported.');
        }
      } else if (key === 'media' && isObj(value) && Object.values(value).some((m) => isObj(m) && hasOwn(m, 'blobId'))) {
        return invalidProperties(['media'], 'blobIds in media is not supported.');
      }
      if (!(type === 'ContactCard' ? CARD_PROPERTIES : EVENT_PROPERTIES).has(key)) {
        return invalidProperties([key], 'Invalid property.');
      }
      assignOrDelete(draft.data, key, value);
    }
    if (draft.parents.length === 0) {
      return invalidProperties(
        [parentProp],
        type === 'ContactCard'
          ? 'Contact has to belong to at least one address book.'
          : 'Event has to belong to at least one calendar.',
      );
    }
    return null;
  }

  private prepareCreate(type: ItemType, account: Account, object: Obj, createdInCall: Set<string>): Draft | { error: SetErrorShape } {
    const draft: Draft = { data: {}, parents: [], flags: {} };
    const error = this.applyItemProperties(type, draft, object, null);
    if (error) return { error };
    const containerType = containerOf(type);
    for (const parent of draft.parents) {
      if (!account.objects[containerType].has(parent)) {
        return {
          error: invalidProperties(
            [parentProperty(type)],
            type === 'ContactCard' ? `addressBookId ${parent} does not exist.` : `calendarId ${parent} does not exist.`,
          ),
        };
      }
      if (!this.canWrite(account, containerType, parent)) {
        return {
          error: {
            type: 'forbidden',
            description:
              type === 'ContactCard'
                ? `You are not allowed to add contacts to address book ${parent}.`
                : `You are not allowed to add calendar events to calendar ${parent}.`,
          },
        };
      }
    }
    // Both uid checks read what was committed before this call, so two
    // creates with one uid in the same call both pass (as on Stalwart).
    const earlier = [...account.objects[type].values()].filter((s) => !createdInCall.has(s.id));
    if (type === 'ContactCard') {
      draft.data = normalizeCard(draft.data);
      const uid = draft.data.uid;
      // Contact uids are unique per address book; the error names the card (verified).
      const clash = typeof uid === 'string'
        ? earlier.find((s) => s.data.uid === uid && s.parents.some((p) => draft.parents.includes(p)))
        : undefined;
      if (clash) {
        return { error: invalidProperties(['uid'], `Contact with UID ${String(uid)} already exists with id ${clash.id}.`) };
      }
      return draft;
    }
    // Stalwart generates a UUID when the create has no uid.
    if (typeof draft.data.uid !== 'string') draft.data.uid = this.mintUid();
    if (draft.flags.useDefaultAlerts === true) this.addDefaultAlerts(account, draft);
    draft.data = normalizeEvent(draft.data, this.nowUtc(), 'jmap');
    this.assignOrganizer(account, draft.data);
    // Event uids are unique per account; the error names no event (verified).
    const uid = draft.data.uid;
    if (earlier.some((s) => s.data.uid === uid)) {
      return { error: invalidProperties(['uid'], `An event with UID ${String(uid)} already exists.`) };
    }
    return draft;
  }

  private prepareUpdate(type: ItemType, account: Account, stored: Stored, patch: Obj): Draft | { error: SetErrorShape } {
    const draft: Draft = { data: clone(stored.data), parents: [...stored.parents], flags: { ...stored.flags } };
    const error = this.applyItemProperties(type, draft, patch, stored.id);
    if (error) return { error };
    if (type === 'ContactCard') {
      draft.data = normalizeCard(draft.data);
    } else {
      draft.data = normalizeEvent(draft.data, this.nowUtc(), 'jmap');
      this.assignOrganizer(account, draft.data);
    }
    // A uid can be stripped (`uid: null`) but not changed or added.
    if (draft.data.uid !== undefined && draft.data.uid !== stored.data.uid) {
      return {
        error: invalidProperties(
          ['uid'],
          type === 'ContactCard' ? 'You cannot change the UID of a contact.' : 'You cannot change the UID of a calendar event.',
        ),
      };
    }
    const containerType = containerOf(type);
    const noun = type === 'ContactCard' ? 'contacts' : 'calendar events';
    const place = type === 'ContactCard' ? 'address book' : 'calendar';
    for (const parent of draft.parents) {
      if (stored.parents.includes(parent)) continue;
      if (!account.objects[containerType].has(parent)) {
        return {
          error: invalidProperties(
            [parentProperty(type)],
            type === 'ContactCard' ? `addressBookId ${parent} does not exist.` : `calendarId ${parent} does not exist.`,
          ),
        };
      }
      if (!this.canWrite(account, containerType, parent)) {
        return { error: { type: 'forbidden', description: `You are not allowed to add ${noun} to ${place} ${parent}.` } };
      }
    }
    for (const parent of stored.parents) {
      if (draft.parents.includes(parent) || this.canWrite(account, containerType, parent)) continue;
      return { error: { type: 'forbidden', description: `You are not allowed to remove ${noun} from ${place} ${parent}.` } };
    }
    for (const parent of draft.parents) {
      if (!stored.parents.includes(parent) || this.canWrite(account, containerType, parent)) continue;
      return { error: { type: 'forbidden', description: `You are not allowed to modify ${place} ${parent}.` } };
    }
    return draft;
  }

  /**
   * `useDefaultAlerts: true` on create copies the calendars' default alerts
   * into the event as alarms without a JSID, so they read back with the
   * positional keys `k<n>` after the event's own alerts. (Stalwart can then
   * emit a duplicate key; here a taken key moves to the next free one.)
   */
  private addDefaultAlerts(account: Account, draft: Draft): void {
    const withoutTime = draft.data.showWithoutTime === true;
    const alerts: Obj = isObj(draft.data.alerts) ? draft.data.alerts : {};
    let position = Object.keys(alerts).length;
    for (const calendarId of draft.parents) {
      const calendar = account.objects.Calendar.get(calendarId);
      const defaults = calendar?.data[withoutTime ? 'defaultAlertsWithoutTime' : 'defaultAlertsWithTime'];
      if (!isObj(defaults)) continue;
      for (const alert of Object.values(defaults)) {
        let key = `k${++position}`;
        while (hasOwn(alerts, key)) key = `k${++position}`;
        setKey(alerts, key, clone(alert));
      }
    }
    if (Object.keys(alerts).length > 0) draft.data.alerts = alerts;
  }

  /**
   * `itip_assign_organizer`: an event whose participants include attendees
   * but that has no organizer gets the account's first address as organizer,
   * which reads back as `organizerCalendarAddress` plus an owner participant
   * keyed uuid5 of the address (merged into a participant with that address,
   * if any). Approximated: only the master, and "attendee" means a
   * participant with a calendar address that is not only an owner.
   */
  private assignOrganizer(account: Account, event: Obj): void {
    const address = account.addresses[0];
    const participants = event.participants;
    if (!address || typeof event.organizerCalendarAddress === 'string' || !isObj(participants)) return;
    const hasAttendee = Object.values(participants).some((p) => {
      if (!isObj(p) || typeof p.calendarAddress !== 'string') return false;
      const roles = isObj(p.roles) ? Object.keys(p.roles).filter((role) => (p.roles as Obj)[role] === true) : [];
      return !(roles.length === 1 && roles[0] === 'owner');
    });
    if (!hasAttendee) return;
    const uri = `mailto:${address}`;
    event.organizerCalendarAddress = uri;
    const existing = Object.values(participants).find((p) => isObj(p) && p.calendarAddress === uri);
    if (isObj(existing)) {
      existing.roles = { ...(isObj(existing.roles) ? existing.roles : {}), owner: true };
    } else {
      setKey(participants, uuid5(uri), { '@type': 'Participant', calendarAddress: uri, roles: { owner: true } });
    }
  }

  // ── Storage ──

  private insertContainer(type: ContainerType, accountId: string, input: Obj): string {
    const account = this.requireAccount(accountId);
    const { id: explicitId, isDefault, ...rest } = clone(input);
    const id = this.mintId(account, type, explicitId);
    const data = { ...clone(type === 'AddressBook' ? ADDRESS_BOOK_DEFAULTS : CALENDAR_DEFAULTS), ...rest };
    if (isDefault === true) account.defaultContainer[type] = id;
    this.storeNew(account, type, id, { data, parents: [], flags: {} });
    const pending = new PendingChanges();
    pending.insert('container', id);
    this.commit(account, groupOf(type), pending);
    return id;
  }

  private insertItem(type: ItemType, accountId: string, input: Obj): string {
    const account = this.requireAccount(accountId);
    const containerType = containerOf(type);
    const object = clone(input);
    const explicitId = object.id;
    const parentInput = object[parentProperty(type)];
    delete object.id;
    delete object[parentProperty(type)];
    let parents: string[];
    if (parentInput === undefined) {
      const fallback = this.defaultContainerId(account, containerType);
      if (!fallback) throw new Error(`fake server: ${accountId} has no ${containerType} for the new ${type}`);
      parents = [fallback];
    } else if (isObj(parentInput)) {
      parents = Object.keys(parentInput).filter((p) => parentInput[p] === true);
    } else {
      throw new Error(`fake server: ${parentProperty(type)} must be a map`);
    }
    for (const parent of parents) this.requireObject(account, containerType, parent);
    const flags: Obj = {};
    if (type === 'CalendarEvent') {
      for (const flag of EVENT_FLAGS) {
        if (!hasOwn(object, flag)) continue;
        flags[flag] = object[flag];
        delete object[flag];
      }
    }
    const data = type === 'ContactCard' ? normalizeCard(object) : normalizeEvent(object, this.nowUtc(), 'server');
    const id = this.mintId(account, type, explicitId);
    this.storeNew(account, type, id, { data, parents, flags });
    const pending = new PendingChanges();
    pending.insert('item', id);
    this.commit(account, groupOf(type), pending);
    return id;
  }

  private storeNew(account: Account, type: DataType, id: string, draft: Draft): void {
    account.objects[type].set(id, {
      id,
      docId: ++account.docCounter[type],
      data: draft.data,
      parents: draft.parents,
      flags: draft.flags,
      uidVisibleFrom: this.uidLag === 0 ? 0 : this.requestSeq + this.uidLag + 1,
      modSeq: ++this.modSeq,
    });
  }

  /** `<prefix><counter in base36>`, per account and type; ids are never reused. */
  private mintId(account: Account, type: DataType, explicit?: unknown): string {
    const used = account.usedIds[type];
    if (explicit !== undefined) {
      if (typeof explicit !== 'string' || !ID_PATTERN.test(explicit)) throw new Error(`fake server: invalid id ${String(explicit)}`);
      if (used.has(explicit)) throw new Error(`fake server: ${type} id ${explicit} was used before (ids are never reused)`);
      used.add(explicit);
      return explicit;
    }
    let id: string;
    do {
      id = `${ID_PREFIX[type]}${(++account.idCounter[type]).toString(36)}`;
    } while (used.has(id));
    used.add(id);
    return id;
  }

  private mintUid(): string {
    return `00000000-0000-4000-8000-${(++this.uidCounter).toString(16).padStart(12, '0')}`;
  }

  /** One commit: a new account-wide change id in the collection's log. */
  private commit(account: Account, group: TypeGroup, pending: PendingChanges): number | null {
    const changes = pending.toChanges();
    if (changes.length === 0) return null;
    const changeId = ++account.lastChangeId;
    account.logs[group].append(changeId, changes);
    return changeId;
  }

  private stateOf(account: Account, type: DataType): string {
    return encodeState(stateOfChangeId(account.logs[groupOf(type)].sideChangeId(sideOf(type))));
  }

  /** The container marked default, else the oldest one (Stalwart: the lowest id). */
  private defaultContainerId(account: Account, type: ContainerType): string | undefined {
    const marked = account.defaultContainer[type];
    if (marked && account.objects[type].has(marked)) return marked;
    return account.objects[type].keys().next().value;
  }

  private canWrite(account: Account, type: ContainerType, id: string): boolean {
    const rights = account.objects[type].get(id)?.data.myRights;
    if (!isObj(rights)) return true;
    return type === 'AddressBook' ? rights.mayWrite !== false : rights.mayWriteAll !== false;
  }

  private requireAccount(accountId: string): Account {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error(`fake server: no account ${accountId}`);
    return account;
  }

  private requireObject(account: Account, type: DataType, id: string): Stored {
    const stored = account.objects[type].get(id);
    if (!stored) throw new Error(`fake server: no ${type} ${id} in ${account.id}`);
    return stored;
  }
}

function hasBlobLink(entry: unknown): boolean {
  if (!isObj(entry) || !isObj(entry.links)) return false;
  return Object.values(entry.links).some((link) => isObj(link) && hasOwn(link, 'blobId'));
}
