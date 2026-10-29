// Templates kept in an account's Inbox metadata (Stalwart 1.0.0 and later),
// as the webmail keeps them (lib/templates/metadata-templates.ts): one
// namespace per template, `org.bulwarkmail.template.<id>`, because Stalwart
// takes at most 8 KB per namespace. Personal templates go in the user's own
// Inbox, team templates in a group account's.
//
// Deletions of personal templates are tombstones in the marker entry
// `org.bulwarkmail.templates` ({ version, deleted: { id: deletedAt } }), and
// only tombstones delete: an entry that is simply missing (a request that
// failed half way, another client) is uploaded again, never taken as a
// deletion.
//
// Pure: reading the entries and planning how the copy on this device and the
// server copy come together. stores/templates-store does the requests.

import type { EmailTemplate } from '../stores/templates-store';
import { isValidMetadataKey, MAX_METADATA_ENTRY_BYTES, metadataValueBytes } from '../api/bulwark-metadata';

const KEY_PREFIX = 'template.';
/** The marker entry: tombstones of deleted personal templates. */
export const MARKER_KEY = 'templates';
export const MARKER_VERSION = 1;
/**
 * Tombstones older than this are dropped. A device offline for longer may
 * bring a deleted template back: the accepted trade-off for a bounded marker.
 */
export const TEMPLATE_TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** The metadata key of a template (`template.<id>`). */
export function templateKey(id: string): string {
  return `${KEY_PREFIX}${id}`;
}

/** 53-bit string hash (cyrb53), as 14 hex digits. */
function hash53(text: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/**
 * An id that fits a metadata key, derived from the old one: the same old id
 * gives the same new id on every device and in the webmail, so the copies
 * still meet by id.
 */
export function storableId(id: string): string {
  return isValidMetadataKey(templateKey(id)) ? id : `${hash53(id, 1)}${hash53(id, 2)}`;
}

/** The same template with an id that fits a metadata key. */
export function withStorableId(template: EmailTemplate): EmailTemplate {
  const id = storableId(template.id);
  return id === template.id ? template : { ...template, id };
}

/** Whether a template is larger than one metadata entry may be. */
export function isTooLargeForMetadata(template: EmailTemplate): boolean {
  return metadataValueBytes(template) > MAX_METADATA_ENTRY_BYTES;
}

/** A template as another client stored it, or null when it is not one. */
function parseTemplate(value: unknown, id: string): EmailTemplate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const t = value as Record<string, unknown>;
  if (typeof t.name !== 'string' || !t.name.trim()) return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined);
  const recipients = t.defaultRecipients as Record<string, unknown> | undefined;
  // A fixed time, not now: a copy without a date must never win a merge.
  const unknownTime = new Date(0).toISOString();
  return {
    id,
    name: t.name,
    subject: str(t.subject),
    body: str(t.body),
    isHTML: Boolean(t.isHTML),
    category: str(t.category),
    defaultRecipients: recipients && typeof recipients === 'object'
      ? { to: list(recipients.to), cc: list(recipients.cc), bcc: list(recipients.bcc) }
      : undefined,
    identityId: typeof t.identityId === 'string' ? t.identityId : undefined,
    isFavorite: Boolean(t.isFavorite),
    createdAt: typeof t.createdAt === 'string' ? t.createdAt : unknownTime,
    updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : unknownTime,
  };
}

/** The templates among an Inbox's Bulwark entries (`template.<id>`), by id. The key decides the id. */
export function templatesFromMetadata(entries: Record<string, unknown> | null | undefined): Record<string, EmailTemplate> {
  const out: Record<string, EmailTemplate> = {};
  for (const [key, value] of Object.entries(entries ?? {})) {
    if (!key.startsWith(KEY_PREFIX)) continue;
    const id = key.slice(KEY_PREFIX.length);
    const template = parseTemplate(value, id);
    if (template) out[id] = template;
  }
  return out;
}

function parseTombstones(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [id, at] of Object.entries(value as Record<string, unknown>)) {
    if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) out[id] = at;
  }
  return out;
}

/** The tombstones of the marker entry, or null when there is none. */
export function markerFromMetadata(entries: Record<string, unknown> | null | undefined): Record<string, string> | null {
  const value = entries?.[MARKER_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return parseTombstones((value as Record<string, unknown>).deleted);
}

/** Tombstones of the last 90 days, newest first as long as the marker stays within 8 KB. */
export function pruneTombstones(deleted: Record<string, string>, now: Date = new Date()): Record<string, string> {
  const cutoff = now.getTime() - TEMPLATE_TOMBSTONE_TTL_MS;
  const fresh = Object.entries(deleted)
    .filter(([, at]) => Date.parse(at) >= cutoff)
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]));
  const kept: Record<string, string> = {};
  for (const [id, at] of fresh) {
    kept[id] = at;
    if (metadataValueBytes({ version: MARKER_VERSION, deleted: kept }) > MAX_METADATA_ENTRY_BYTES) {
      delete kept[id];
      break;
    }
  }
  return kept;
}

/** The newest tombstone per id of both sets. */
export function unionTombstones(a: Record<string, string>, b: Record<string, string>): Record<string, string> {
  const out = { ...a };
  for (const [id, at] of Object.entries(b)) {
    if (!out[id] || Date.parse(at) > Date.parse(out[id])) out[id] = at;
  }
  return out;
}

export function sameTombstones(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((id) => a[id] === b[id]);
}

export interface TemplateList {
  templates: EmailTemplate[];
  /** Template id -> ISO time it was deleted. */
  deletedTemplateIds: Record<string, string>;
}

/**
 * Merge two template lists: per id the newer `updatedAt` wins (ties keep
 * `local`); a tombstone beats a template unless the template was edited
 * after it, which brings it back and clears the tombstone (webmail
 * mergeSyncedTemplates).
 */
export function mergeTemplateLists(local: TemplateList, incoming: TemplateList, now: Date = new Date()): TemplateList {
  const cutoff = now.getTime() - TEMPLATE_TOMBSTONE_TTL_MS;
  const tombstones: Record<string, string> = {};
  for (const source of [local.deletedTemplateIds, incoming.deletedTemplateIds]) {
    for (const [id, at] of Object.entries(source)) {
      if (Date.parse(at) < cutoff) continue;
      if (!tombstones[id] || Date.parse(at) > Date.parse(tombstones[id])) tombstones[id] = at;
    }
  }
  const byId = new Map<string, EmailTemplate>();
  for (const t of local.templates) byId.set(t.id, t);
  for (const t of incoming.templates) {
    const existing = byId.get(t.id);
    if (!existing || Date.parse(t.updatedAt) > Date.parse(existing.updatedAt)) byId.set(t.id, t);
  }
  const templates: EmailTemplate[] = [];
  for (const t of byId.values()) {
    const deletedAt = tombstones[t.id];
    if (deletedAt !== undefined) {
      if (Date.parse(t.updatedAt) <= Date.parse(deletedAt)) continue;
      delete tombstones[t.id];
    }
    templates.push(t);
  }
  return { templates, deletedTemplateIds: tombstones };
}

export interface PersonalSyncPlan extends TemplateList {
  /** Templates the server lacks or holds an older version of. */
  uploads: EmailTemplate[];
  /** Ids to remove from the server, each covered by a tombstone. */
  deletes: string[];
}

/**
 * Brings this device's copy and the server copy together, per id with the
 * newer `updatedAt` winning, with the tombstones of both (webmail
 * planPersonalSync).
 */
export function planPersonalSync(
  local: TemplateList,
  server: Record<string, EmailTemplate>,
  serverTombstones: Record<string, string>,
  now: Date = new Date(),
): PersonalSyncPlan {
  const tombstones = unionTombstones(local.deletedTemplateIds, serverTombstones);
  const merged = mergeTemplateLists(
    { templates: local.templates, deletedTemplateIds: tombstones },
    { templates: Object.values(server), deletedTemplateIds: {} },
    now,
  );
  const keptIds = new Set(merged.templates.map((t) => t.id));
  const uploads = merged.templates.filter((template) => {
    const there = server[template.id];
    return !there || Date.parse(template.updatedAt) > Date.parse(there.updatedAt);
  });
  const deletes = Object.keys(server).filter((id) => !keptIds.has(id) && merged.deletedTemplateIds[id] !== undefined);
  return { templates: merged.templates, deletedTemplateIds: pruneTombstones(merged.deletedTemplateIds, now), uploads, deletes };
}
