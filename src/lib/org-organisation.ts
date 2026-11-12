/**
 * The organisation part of the webmail's policy (policy.json `organisation`)
 * that the app reads beyond the signature, disclaimer, recovery and
 * templates: session limits, the announcement, the Trash and Junk
 * retention, the device rules and the out-of-office templates.
 *
 * Ported from the webmail's lib/admin/organisation-policy.ts
 * (sanitizeOrganisationPartial, mergeOrganisation, strictestDevices) for
 * these sections. The policy store keeps `organisation` and each scope's
 * `organisation` as sent; this module checks them and merges the scopes the
 * webmail's way: the announcement is replaced as a whole by a scope that
 * sets it, out-of-office templates add up by id, and the offline caps keep
 * the strictest value across scopes.
 */

import type { OrgPolicy, PolicyScope, PolicySubject } from './org-policy';

export const ANNOUNCEMENT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AnnouncementSeverity = (typeof ANNOUNCEMENT_SEVERITIES)[number];

export interface OrgSessionPolicy {
  /** Sign out after this many minutes without activity; 0 is off. */
  idleMinutes: number;
  /** Sign out this many hours after signing in; 0 is off. */
  maxHours: number;
  /** How long the warning counts down before signing out. */
  warnSeconds: number;
}

export interface OrgAnnouncement {
  /** Changes when the admin saves a new announcement, so dismissals reset. */
  id: string;
  severity: AnnouncementSeverity;
  /** Locale (en, de, pt-BR) to plain text with links; {} shows nothing. */
  text: Record<string, string>;
  fallbackLocale: string;
  /** ISO times; '' for no limit. */
  startsAt: string;
  endsAt: string;
  dismissible: boolean;
}

export interface OrgRetention {
  trashDays: number;
  junkDays: number;
}

export interface OrgDevices {
  noDownloads: boolean;
  noExport: boolean;
  noPrint: boolean;
  noInstallPrompt: boolean;
  pushWithoutContent: boolean;
  watermark: boolean;
  noOffline: boolean;
  /** How far back a device keeps mail, in days. 0 is no cap. */
  offlineMaxDays: number;
  noOfflineAttachments: boolean;
  /** The largest attachment or file a device keeps, in MB. 0 is no cap. */
  offlineMaxAttachmentMb: number;
  /** Everything one account keeps on a device, in MB. 0 is no cap. */
  offlineMaxTotalMb: number;
  /** Delete an account's data on the device as soon as it is signed out without asking. */
  wipeOnForcedSignOut: boolean;
}

/** An out-of-office reply text of the admin library. */
export interface OrgVacationTemplate {
  id: string;
  name: string;
  category: string;
  subject: string;
  /** Plain text with placeholders like {name}, {end}, {deputy}. */
  text: string;
  /** Optional HTML version; '' for none. */
  html: string;
}

export interface OrganisationParts {
  session: OrgSessionPolicy;
  announcement: OrgAnnouncement;
  retention: OrgRetention;
  devices: OrgDevices;
  vacationTemplates: { library: OrgVacationTemplate[] };
}

type Partial2<T> = { [K in keyof T]?: Partial<T[K]> };
export type OrganisationPartial = Partial2<OrganisationParts>;

export const NO_DEVICE_LIMITS: OrgDevices = {
  noDownloads: false, noExport: false, noPrint: false, noInstallPrompt: false,
  pushWithoutContent: false, watermark: false, noOffline: false,
  offlineMaxDays: 0, noOfflineAttachments: false, offlineMaxAttachmentMb: 0, offlineMaxTotalMb: 0,
  wipeOnForcedSignOut: false,
};

export const DEFAULT_ORGANISATION: OrganisationParts = {
  session: { idleMinutes: 0, maxHours: 0, warnSeconds: 60 },
  announcement: { id: '', severity: 'info', text: {}, fallbackLocale: 'en', startsAt: '', endsAt: '', dismissible: true },
  retention: { trashDays: 0, junkDays: 0 },
  devices: NO_DEVICE_LIMITS,
  vacationTemplates: { library: [] },
};

const MAX_TEXT = 64 * 1024;
const MAX_LIBRARY = 200;
const MAX_OFFLINE_DAYS = 3650;
const MAX_OFFLINE_MB = 1024 * 1024;
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, MAX_TEXT) : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function count(value: unknown, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(0, Math.round(value)));
}

function line(value: unknown, max: number): string | undefined {
  const t = text(value);
  // eslint-disable-next-line no-control-regex
  return t === undefined ? undefined : t.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function isoTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (v === '') return '';
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

function itemId(value: unknown): string | null {
  return typeof value === 'string' && ID_RE.test(value.trim()) ? value.trim() : null;
}

function sanitizeLocaleText(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [locale, body] of Object.entries(value)) {
    const t = text(body)?.trim();
    if (LOCALE_RE.test(locale) && t) out[locale] = t.slice(0, 4000);
  }
  return out;
}

function sanitizeVacationLibrary(value: unknown): OrgVacationTemplate[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: OrgVacationTemplate[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = itemId(item.id);
    const name = line(item.name, 200);
    if (!id || seen.has(id) || !name) continue;
    seen.add(id);
    out.push({
      id,
      name,
      category: line(item.category, 100) ?? '',
      subject: line(item.subject, 511) ?? '',
      text: text(item.text) ?? '',
      html: text(item.html) ?? '',
    });
    if (out.length >= MAX_LIBRARY) break;
  }
  return out;
}

/** The valid keys of the sections this module reads, without defaults (a missing key inherits). */
export function sanitizeOrganisationPartial(raw: unknown): OrganisationPartial {
  if (!isRecord(raw)) return {};
  const out: Record<string, Record<string, unknown>> = {};
  const section = (key: keyof OrganisationParts) => (isRecord(raw[key]) ? (raw[key] as Record<string, unknown>) : null);
  const assign = (key: keyof OrganisationParts, values: Record<string, unknown>) => {
    const kept = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined));
    if (Object.keys(kept).length > 0) out[key] = kept;
  };

  const ses = section('session');
  if (ses) assign('session', {
    idleMinutes: count(ses.idleMinutes, 7 * 24 * 60),
    maxHours: count(ses.maxHours, 24 * 365),
    warnSeconds: count(ses.warnSeconds, 600),
  });

  const ann = section('announcement');
  if (ann) assign('announcement', {
    id: typeof ann.id === 'string' ? (itemId(ann.id) ?? '') : undefined,
    severity: oneOf(ann.severity, ANNOUNCEMENT_SEVERITIES),
    text: sanitizeLocaleText(ann.text),
    fallbackLocale: typeof ann.fallbackLocale === 'string' && LOCALE_RE.test(ann.fallbackLocale) ? ann.fallbackLocale : undefined,
    startsAt: isoTime(ann.startsAt),
    endsAt: isoTime(ann.endsAt),
    dismissible: bool(ann.dismissible),
  });

  const vac = section('vacationTemplates');
  if (vac) assign('vacationTemplates', { library: sanitizeVacationLibrary(vac.library) });

  const ret = section('retention');
  if (ret) assign('retention', { trashDays: count(ret.trashDays, 3650), junkDays: count(ret.junkDays, 3650) });

  const dev = section('devices');
  if (dev) assign('devices', {
    noDownloads: bool(dev.noDownloads),
    noExport: bool(dev.noExport),
    noPrint: bool(dev.noPrint),
    noInstallPrompt: bool(dev.noInstallPrompt),
    pushWithoutContent: bool(dev.pushWithoutContent),
    watermark: bool(dev.watermark),
    noOffline: bool(dev.noOffline),
    offlineMaxDays: count(dev.offlineMaxDays, MAX_OFFLINE_DAYS),
    noOfflineAttachments: bool(dev.noOfflineAttachments),
    offlineMaxAttachmentMb: count(dev.offlineMaxAttachmentMb, MAX_OFFLINE_MB),
    offlineMaxTotalMb: count(dev.offlineMaxTotalMb, MAX_OFFLINE_MB),
    wipeOnForcedSignOut: bool(dev.wipeOnForcedSignOut),
  });

  return out as OrganisationPartial;
}

/** The smaller of two caps, where 0 is no cap. */
export function tighterCap(a: number, b: number): number {
  if (!(a > 0)) return b > 0 ? b : 0;
  return b > 0 ? Math.min(a, b) : a;
}

/** Device keys where the strictest value wins across scopes (a group scope can't raise a domain scope's cap). */
const STRICTEST_DEVICE_MERGE: Partial<Record<keyof OrgDevices, (a: never, b: never) => unknown>> = {
  offlineMaxDays: tighterCap,
  offlineMaxAttachmentMb: tighterCap,
  offlineMaxTotalMb: tighterCap,
  noOfflineAttachments: (a: boolean, b: boolean) => a || b,
};

/** Every limit either side sets (webmail strictestDevices). */
export function strictestDevices(base: OrgDevices, other: Partial<OrgDevices>): OrgDevices {
  const out = { ...base } as Record<string, boolean | number>;
  for (const [key, value] of Object.entries(other)) {
    const current = out[key];
    if (typeof current === 'number') out[key] = tighterCap(current, typeof value === 'number' ? value : 0);
    else if (value === true) out[key] = true;
  }
  return out as unknown as OrgDevices;
}

/** Sections a scope replaces as a whole. */
const WHOLE_SECTIONS = new Set<keyof OrganisationParts>(['announcement']);
/** Lists that add up across scopes by id. */
const ADDITIVE_LISTS: Partial<Record<keyof OrganisationParts, string>> = { vacationTemplates: 'library' };

/** webmail mergeOrganisation, for the sections here. */
export function mergeOrganisation(base: OrganisationParts, override: OrganisationPartial): OrganisationParts {
  const out = { ...base } as unknown as Record<string, Record<string, unknown>>;
  const defaults = DEFAULT_ORGANISATION as unknown as Record<string, Record<string, unknown>>;
  for (const [sectionKey, values] of Object.entries(override)) {
    if (!isRecord(values) || !isRecord(out[sectionKey])) continue;
    const key0 = sectionKey as keyof OrganisationParts;
    const merged: Record<string, unknown> = WHOLE_SECTIONS.has(key0) ? { ...defaults[sectionKey] } : { ...out[sectionKey] };
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      if (ADDITIVE_LISTS[key0] === key && Array.isArray(value)) {
        const byId = new Map((merged[key] as Array<{ id: string }>).map((t) => [t.id, t]));
        for (const item of value as Array<{ id: string }>) byId.set(item.id, item);
        merged[key] = [...byId.values()];
      } else if (sectionKey === 'devices' && STRICTEST_DEVICE_MERGE[key as keyof OrgDevices]) {
        const pick = STRICTEST_DEVICE_MERGE[key as keyof OrgDevices] as (a: unknown, b: unknown) => unknown;
        merged[key] = pick(merged[key], value);
      } else {
        merged[key] = value;
      }
    }
    out[sectionKey] = merged;
  }
  return out as unknown as OrganisationParts;
}

function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase().replace(/\.+$/, '') : '';
}

function domainPatternMatches(pattern: string, domain: string): boolean {
  if (!domain) return false;
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1);
    return domain.endsWith(suffix) && domain.length > suffix.length;
  }
  return pattern === domain;
}

/** The scopes that apply to `subject`, domain matches first, as resolvePolicy orders them. */
export function scopesFor(scopes: readonly PolicyScope[], subject: PolicySubject | null): PolicyScope[] {
  if (!subject) return [];
  const domain = domainOf(subject.email);
  const groups = new Set(subject.groups.map((g) => g.trim().toLowerCase()));
  const byDomain = scopes.filter((s) => (s.match.domains ?? []).some((p) => domainPatternMatches(p, domain)));
  const byGroup = scopes.filter((s) => !byDomain.includes(s) && (s.match.groups ?? []).some((g) => groups.has(g)));
  return [...byDomain, ...byGroup];
}

const resolved = new WeakMap<OrgPolicy, Map<string, OrganisationParts>>();

/**
 * The organisation settings of a fetched policy (scopes included) for
 * `subject`: the global ones with each matching scope merged on top. The
 * defaults without a policy. Memoised per policy object and subject.
 */
export function organisationFor(policy: OrgPolicy | null | undefined, subject: PolicySubject | null): OrganisationParts {
  if (!policy) return DEFAULT_ORGANISATION;
  const key = subject ? `${subject.email}|${[...subject.groups].sort().join(',')}` : '';
  let perSubject = resolved.get(policy);
  const hit = perSubject?.get(key);
  if (hit) return hit;
  let org = mergeOrganisation(DEFAULT_ORGANISATION, sanitizeOrganisationPartial(policy.organisation));
  for (const scope of scopesFor(policy.scopes, subject)) {
    org = mergeOrganisation(org, sanitizeOrganisationPartial(scope.policy.organisation));
  }
  if (!perSubject) {
    perSubject = new Map();
    resolved.set(policy, perSubject);
  }
  perSubject.set(key, org);
  return org;
}
