// Masked addresses (x:MaskedEmail), ported from the webmail's
// lib/stalwart/masked-email.ts: addresses that receive mail without giving
// away the main one, on servers that offer them (Stalwart Enterprise,
// Inbuxa). Stalwart Community refuses every call, which counts as "not
// available" so the section stays hidden there. Same request path as account
// security (account-security.ts send), with the account's management
// capability.

import { jmapClient } from './jmap-client';
import { getManagementCapability, send } from './account-security';

export interface MaskedAddress {
  id: string;
  email: string;
  forDomain: string | null;
  description: string | null;
  enabled: boolean;
}

export class MaskedEmailError extends Error {
  readonly type: string;
  constructor(type: string, description?: string) {
    super(description || type);
    this.name = 'MaskedEmailError';
    this.type = type;
  }
}

export function maskedEmailErrorType(error: unknown): string | undefined {
  return error instanceof MaskedEmailError ? error.type : undefined;
}

/**
 * Stalwart Community answers every call on an Enterprise-only registry
 * object (MaskedEmail among them) with `forbidden` and this detail; any
 * other `forbidden` is a permission the session lacks.
 */
function enterpriseOnly(error: unknown): boolean {
  return error instanceof MaskedEmailError && error.type === 'forbidden'
    && /only available in the enterprise edition/i.test(error.message);
}

/** The server or account has no masked addresses: the section stays hidden. */
export function maskedEmailUnavailable(error: unknown): boolean {
  return ['unknownMethod', 'unknownCapability', 'notImplemented', 'unsupported'].includes(maskedEmailErrorType(error) || '')
    || enterpriseOnly(error);
}

type MaskedEmailRecord = {
  id?: unknown;
  accountId?: unknown;
  email?: unknown;
  forDomain?: unknown;
  description?: unknown;
  enable?: unknown;
  enabled?: unknown;
};

/** One account: the one signed in when it was made. */
export function createMaskedEmailManager() {
  const capability = getManagementCapability();
  if (!capability) return null;
  const accountId = jmapClient.accountId;
  const serverUrl = jmapClient.serverUrl;
  // Stalwart 1.x calls the switch `enable`, Inbuxa's registry `enabled`.
  const enabledProperty = capability === 'urn:stalwart:jmap' ? 'enable' : 'enabled';
  const properties = ['id', 'accountId', 'email', 'forDomain', 'description', enabledProperty];
  const batchSize = Math.min(jmapClient.getMaxObjectsInGet(), 50);
  const ownedIds = new Set<string>();
  const uncertainDeletes = new Set<string>();

  const isCurrent = () => jmapClient.accountId === accountId && jmapClient.serverUrl === serverUrl;

  async function request<T>(method: string, args: Record<string, unknown>): Promise<T & { accountId?: string }> {
    if (!isCurrent()) throw new MaskedEmailError('staleContext');
    let responses: Awaited<ReturnType<typeof send>>;
    try {
      responses = await send([[method, { ...args, accountId }, 'masked']]);
    } catch (err) {
      // A request-level refusal names the problem in its text.
      const message = err instanceof Error ? err.message : String(err);
      throw new MaskedEmailError(/unknownCapability/i.test(message) ? 'unknownCapability' : 'requestFailed', message);
    }
    if (!isCurrent()) throw new MaskedEmailError('staleContext');
    const match = responses.find((r) => r[2] === 'masked');
    if (!match) throw new MaskedEmailError('invalidResponse');
    if (match[0] === 'error') {
      const body = match[1] as { type?: string; description?: string };
      throw new MaskedEmailError(body.type || 'serverFail', body.description);
    }
    const result = match[1] as T & { accountId?: string };
    if (result.accountId !== undefined && result.accountId !== accountId) throw new MaskedEmailError('ownershipMismatch');
    return result;
  }

  function verifyRecord(raw: MaskedEmailRecord): MaskedAddress {
    if (Object.prototype.hasOwnProperty.call(raw, 'accountId') && raw.accountId !== accountId) {
      throw new MaskedEmailError('ownershipMismatch');
    }
    const enabled = raw[enabledProperty];
    if (typeof raw.id !== 'string' || typeof raw.email !== 'string' || typeof enabled !== 'boolean'
      || !(raw.description == null || typeof raw.description === 'string')
      || !(raw.forDomain == null || typeof raw.forDomain === 'string')) {
      throw new MaskedEmailError('invalidResponse');
    }
    return {
      id: raw.id,
      email: raw.email,
      enabled,
      description: (raw.description as string | null | undefined) ?? null,
      forDomain: (raw.forDomain as string | null | undefined) ?? null,
    };
  }

  return {
    isCurrent,

    async list(): Promise<MaskedAddress[]> {
      const addresses: MaskedAddress[] = [];
      const seen = new Set<string>();
      let position = 0;
      let expectedTotal: number | undefined;
      for (;;) {
        // The accountId filter matters even for a privileged session.
        const page = await request<{ ids?: unknown; total?: unknown }>('x:MaskedEmail/query', {
          filter: { accountId }, position, limit: 50, calculateTotal: true,
        });
        const ids = page.ids;
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || seen.has(id))) {
          throw new MaskedEmailError('invalidResponse');
        }
        if (page.total !== undefined) {
          if (typeof page.total !== 'number' || !Number.isSafeInteger(page.total) || page.total < position + ids.length) {
            throw new MaskedEmailError('invalidResponse');
          }
          if (expectedTotal !== undefined && page.total !== expectedTotal) throw new MaskedEmailError('listChanged');
          expectedTotal = page.total;
        }
        if (ids.length === 0) {
          if (position === 0) {
            // A registry query may succeed where the object's get is not
            // allowed (Stalwart Community): check without creating one.
            const empty = await request<{ list?: unknown }>('x:MaskedEmail/get', { ids: [], properties });
            if (!Array.isArray(empty.list) || empty.list.length !== 0) throw new MaskedEmailError('invalidResponse');
          }
          break;
        }
        (ids as string[]).forEach((id) => seen.add(id));
        for (let offset = 0; offset < ids.length; offset += batchSize) {
          const batch = (ids as string[]).slice(offset, offset + batchSize);
          const got = await request<{ list?: unknown }>('x:MaskedEmail/get', { ids: batch, properties });
          if (!Array.isArray(got.list)) throw new MaskedEmailError('invalidResponse');
          for (const raw of got.list as MaskedEmailRecord[]) {
            if (!batch.includes(raw.id as string) || addresses.some((a) => a.id === raw.id)) {
              throw new MaskedEmailError('invalidResponse');
            }
            addresses.push(verifyRecord(raw));
          }
        }
        position += ids.length;
        if (position === expectedTotal) break;
      }
      if (expectedTotal !== undefined && addresses.length !== expectedTotal) throw new MaskedEmailError('listChanged');
      ownedIds.clear();
      addresses.forEach((a) => ownedIds.add(a.id));
      uncertainDeletes.clear();
      return addresses;
    },

    async create(input: { description: string; forDomain: string }): Promise<string> {
      const result = await request<{
        created?: Record<string, { id?: unknown }>;
        notCreated?: Record<string, { type: string; description?: string }>;
      }>('x:MaskedEmail/set', {
        create: {
          new: {
            // Stalwart refuses a present but empty string: no description is null.
            description: input.description.trim() || null,
            forDomain: input.forDomain.trim() || null,
            [enabledProperty]: true,
          },
        },
      });
      const error = result.notCreated?.new;
      if (error) throw new MaskedEmailError(error.type, error.description);
      const id = result.created?.new?.id;
      if (typeof id !== 'string') throw new MaskedEmailError('invalidResponse');
      return id;
    },

    async update(id: string, changes: { description?: string; enabled?: boolean }): Promise<void> {
      if (!ownedIds.has(id)) throw new MaskedEmailError('ownershipMismatch');
      const patch: Record<string, string | boolean | null> = {};
      if (typeof changes.description === 'string') patch.description = changes.description.trim() || null;
      if (typeof changes.enabled === 'boolean') patch[enabledProperty] = changes.enabled;
      if (!Object.keys(patch).length) throw new MaskedEmailError('invalidProperties');
      const result = await request<{
        updated?: Record<string, unknown> | null;
        notUpdated?: Record<string, { type: string; description?: string }>;
      }>('x:MaskedEmail/set', { update: { [id]: patch } });
      const error = result.notUpdated?.[id];
      if (error) throw new MaskedEmailError(error.type, error.description);
      if (!result.updated || !Object.prototype.hasOwnProperty.call(result.updated, id)) {
        throw new MaskedEmailError('invalidResponse');
      }
    },

    /**
     * A delete whose answer didn't come back is not sent again: the list has
     * to be read first (`deleteUnconfirmed`).
     */
    async destroy(id: string): Promise<void> {
      if (!ownedIds.has(id)) throw new MaskedEmailError('ownershipMismatch');
      if (uncertainDeletes.has(id)) throw new MaskedEmailError('deleteUnconfirmed');
      let result: { destroyed?: unknown; notDestroyed?: Record<string, { type: string; description?: string }> };
      try {
        result = await request('x:MaskedEmail/set', { destroy: [id] });
      } catch (err) {
        const type = maskedEmailErrorType(err);
        if (type === 'forbidden' || type === 'staleContext' || maskedEmailUnavailable(err)) throw err;
        uncertainDeletes.add(id);
        throw new MaskedEmailError('deleteUnconfirmed');
      }
      const error = result.notDestroyed?.[id];
      if (error) throw new MaskedEmailError(error.type, error.description);
      if (!Array.isArray(result.destroyed) || result.destroyed.length !== 1 || result.destroyed[0] !== id) {
        uncertainDeletes.add(id);
        throw new MaskedEmailError('deleteUnconfirmed');
      }
      ownedIds.delete(id);
    },
  };
}

export type MaskedEmailManager = NonNullable<ReturnType<typeof createMaskedEmailManager>>;

/**
 * What the section shows for the signed-in account: the list, or why not.
 * `unavailable` hides the section (no capability, Stalwart Community, a
 * server without the method).
 */
export async function loadMaskedAddresses(
  manager: MaskedEmailManager | null = createMaskedEmailManager(),
): Promise<{ status: 'ready'; addresses: MaskedAddress[] } | { status: 'unavailable' | 'forbidden' | 'error' }> {
  if (!manager) return { status: 'unavailable' };
  try {
    return { status: 'ready', addresses: await manager.list() };
  } catch (err) {
    if (maskedEmailUnavailable(err)) return { status: 'unavailable' };
    return { status: maskedEmailErrorType(err) === 'forbidden' ? 'forbidden' : 'error' };
  }
}
