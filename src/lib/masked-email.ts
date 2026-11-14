// Masked addresses (webmail lib/stalwart/masked-email.ts, #1534): Stalwart's
// x:MaskedEmail objects, addresses that deliver to the account's mailbox
// without giving its real address away. Listing, creating, describing,
// turning off and deleting, with the webmail's checks on every answer.
//
// The calls go through `MaskedEmailIo` (api/masked-email binds it to the
// JMAP client), which names the account and says whether the login the
// manager was made for is still the active one. Nothing is sent, and no
// answer is used, once it is not.

export interface MaskedAddress {
  id: string;
  email: string;
  forDomain: string | null;
  description: string | null;
  enabled: boolean;
}

// Stalwart calls the switch `enable`.
type MaskedEmailRecord = Partial<Omit<MaskedAddress, 'enabled'>> & { accountId?: string; enable?: boolean };

type SetErrors = Record<string, { type: string; description?: string }>;

export class MaskedEmailError extends Error {
  constructor(public readonly type: string, description?: string) {
    super(description || type);
    this.name = 'MaskedEmailError';
  }
}

export function maskedEmailErrorType(error: unknown): string | undefined {
  return error instanceof MaskedEmailError ? error.type : undefined;
}

/**
 * Stalwart Community before 1.1.1 answers every call on an Enterprise-only
 * registry object (MaskedEmail among them) with `forbidden` and this detail
 * (`assert_enterprise_object`, crates/jmap/src/registry/mod.rs). Any other
 * `forbidden` is a permission the sign-in lacks.
 */
function enterpriseOnly(error: unknown): boolean {
  return error instanceof MaskedEmailError && error.type === 'forbidden' &&
    /only available in the enterprise edition/i.test(error.message);
}

/** The server has no masked addresses for this account, as opposed to refusing or failing. */
export function maskedEmailUnavailable(error: unknown): boolean {
  return ['unknownMethod', 'unknownCapability', 'notImplemented', 'unsupported'].includes(maskedEmailErrorType(error) || '') ||
    enterpriseOnly(error);
}

export interface MaskedEmailIo {
  /** The JMAP account every call names. */
  accountId: string;
  /** The server's maxObjectsInGet. */
  maxObjectsInGet: number;
  /** Whether the login and account the manager was made for are still the active ones. */
  isCurrent(): boolean;
  /**
   * One method call, answered with its arguments. A method error is thrown
   * as a `MaskedEmailError` of its type, an expired sign-in as
   * `notAuthenticated`; a request that got no answer throws anything else.
   */
  call(method: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

const has = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

const PAGE = 50;
const PROPERTIES = ['id', 'accountId', 'email', 'forDomain', 'description', 'enable'];

export function createMaskedEmailManager(io: MaskedEmailIo) {
  const { accountId } = io;
  const ownedIds = new Set<string>();
  const destroyAttempts = new Map<string, 'pending' | 'uncertain' | 'confirmed'>();
  const maxGet = io.maxObjectsInGet;
  const batchSize = Number.isInteger(maxGet) && maxGet > 0 ? Math.min(maxGet, PAGE) : 1;
  const isCurrent = () => io.isCurrent();
  const assertCurrent = () => {
    if (!isCurrent()) throw new MaskedEmailError('staleContext');
  };
  async function request<T>(method: string, args: Record<string, unknown>): Promise<T & { accountId?: string }> {
    assertCurrent();
    const result = await io.call(method, { ...args, accountId });
    assertCurrent();
    if (!result || typeof result !== 'object') throw new MaskedEmailError('invalidResponse');
    if (result.accountId !== undefined && result.accountId !== accountId) throw new MaskedEmailError('ownershipMismatch');
    return result as T & { accountId?: string };
  }
  function verifyRecord(raw: MaskedEmailRecord): MaskedAddress {
    // An account-filtered get leaves each record's owner out for ordinary
    // users. The answer's own accountId was checked; a record that does
    // name an owner must still agree with it.
    if (has(raw, 'accountId') && raw.accountId !== accountId) throw new MaskedEmailError('ownershipMismatch');
    if (typeof raw.id !== 'string' || typeof raw.email !== 'string' || typeof raw.enable !== 'boolean' ||
      !(raw.description == null || typeof raw.description === 'string') ||
      !(raw.forDomain == null || typeof raw.forDomain === 'string')) throw new MaskedEmailError('invalidResponse');
    return { id: raw.id, email: raw.email, enabled: raw.enable,
      description: raw.description ?? null, forDomain: raw.forDomain ?? null };
  }
  return {
    isCurrent,
    /** Every masked address of the account, or a throw: never part of the list. */
    async list(): Promise<MaskedAddress[]> {
      const addresses: MaskedAddress[] = [];
      const seen = new Set<string>();
      let position = 0;
      let queryState: string | undefined;
      let expectedTotal: number | undefined;
      // The accountId filter keeps an admin's answer to this account.
      for (;;) {
        const page = await request<{ ids: string[]; queryState?: string; total?: number }>('x:MaskedEmail/query', {
          filter: { accountId }, position, limit: PAGE, calculateTotal: true,
        });
        if (!Array.isArray(page.ids) || page.ids.some((id) => typeof id !== 'string' || seen.has(id))) {
          throw new MaskedEmailError('invalidResponse');
        }
        if (page.total !== undefined) {
          if (!Number.isSafeInteger(page.total) || page.total < position + page.ids.length) throw new MaskedEmailError('invalidResponse');
          if (expectedTotal !== undefined && page.total !== expectedTotal) throw new MaskedEmailError('listChanged');
          expectedTotal = page.total;
        }
        if (queryState !== undefined && page.queryState !== undefined && queryState !== page.queryState) {
          throw new MaskedEmailError('listChanged');
        }
        queryState = page.queryState;
        if (page.ids.length === 0) {
          if (expectedTotal !== undefined && position < expectedTotal) throw new MaskedEmailError('invalidResponse');
          if (position === 0) {
            // The registry's query can succeed where the object's get is
            // not offered (Stalwart Community) or not permitted. An empty
            // get tells, without creating an address.
            const empty = await request<{ list: MaskedEmailRecord[] }>('x:MaskedEmail/get', { ids: [], properties: PROPERTIES });
            if (empty.accountId !== accountId) throw new MaskedEmailError('ownershipMismatch');
            if (!Array.isArray(empty.list) || empty.list.length !== 0) throw new MaskedEmailError('invalidResponse');
          }
          break;
        }
        page.ids.forEach((id) => seen.add(id));
        for (let offset = 0; offset < page.ids.length; offset += batchSize) {
          const ids = page.ids.slice(offset, offset + batchSize);
          const result = await request<{ list: MaskedEmailRecord[] }>('x:MaskedEmail/get', { ids, properties: PROPERTIES });
          if (result.accountId !== accountId) throw new MaskedEmailError('ownershipMismatch');
          if (!Array.isArray(result.list)) throw new MaskedEmailError('invalidResponse');
          for (const raw of result.list) {
            if (!raw || typeof raw.id !== 'string' || !ids.includes(raw.id) || addresses.some((address) => address.id === raw.id)) {
              throw new MaskedEmailError('invalidResponse');
            }
            addresses.push(verifyRecord(raw));
          }
        }
        position += page.ids.length;
        // Stop at a verified complete result, not merely at a short page.
        if (position === expectedTotal) break;
      }
      if (expectedTotal !== undefined && addresses.length !== expectedTotal) throw new MaskedEmailError('listChanged');
      ownedIds.clear();
      addresses.forEach((address) => ownedIds.add(address.id));
      // A complete fresh read settles an uncertain deletion. Pending and
      // confirmed ones stay guarded against being sent twice.
      for (const [id, state] of destroyAttempts) {
        if (state === 'uncertain') destroyAttempts.delete(id);
      }
      return addresses;
    },
    async create(input: { description: string; forDomain: string }): Promise<string> {
      const result = await request<{ created?: Record<string, { id?: unknown }>; notCreated?: SetErrors }>('x:MaskedEmail/set', {
        // Stalwart refuses a present but empty string; none is null.
        create: { new: { description: input.description || null, forDomain: input.forDomain || null, enable: true } },
      });
      const error = result.notCreated?.new;
      if (error) throw new MaskedEmailError(error.type, error.description);
      const id = result.created?.new?.id;
      if (typeof id !== 'string') throw new MaskedEmailError('invalidResponse');
      return id;
    },
    async update(id: string, changes: { description?: string; enabled?: boolean }): Promise<void> {
      assertCurrent();
      if (!ownedIds.has(id)) throw new MaskedEmailError('ownershipMismatch');
      const patch: Record<string, string | boolean | null> = {};
      // A cleared description is removed (null), as Stalwart refuses an empty one.
      if (typeof changes.description === 'string') patch.description = changes.description || null;
      if (typeof changes.enabled === 'boolean') patch.enable = changes.enabled;
      if (!Object.keys(patch).length) throw new MaskedEmailError('invalidProperties');
      const result = await request<{ updated?: Record<string, unknown>; notUpdated?: SetErrors }>('x:MaskedEmail/set', {
        update: { [id]: patch },
      });
      const error = result.notUpdated?.[id];
      if (error) throw new MaskedEmailError(error.type, error.description);
      if (!result.updated || !has(result.updated, id)) throw new MaskedEmailError('invalidResponse');
    },
    /**
     * Deletes one address for good. A delete whose answer never came is not
     * sent again (`deleteUnconfirmed`) until a fresh `list()` has shown
     * whether the address is still there.
     */
    async destroy(id: string): Promise<void> {
      assertCurrent();
      if (!ownedIds.has(id)) throw new MaskedEmailError('ownershipMismatch');
      if (destroyAttempts.has(id)) throw new MaskedEmailError('deleteUnconfirmed');
      destroyAttempts.set(id, 'pending');
      try {
        const result = await request<{ destroyed?: unknown; notDestroyed?: SetErrors }>('x:MaskedEmail/set', { destroy: [id] });
        if (result.accountId !== accountId) throw new MaskedEmailError('ownershipMismatch');
        if (result.destroyed !== undefined && (!Array.isArray(result.destroyed) ||
          result.destroyed.some((value) => value !== id) || result.destroyed.length > 1)) throw new MaskedEmailError('invalidResponse');
        if (result.notDestroyed !== undefined && (!result.notDestroyed || typeof result.notDestroyed !== 'object' ||
          Array.isArray(result.notDestroyed) || Object.keys(result.notDestroyed).some((key) => key !== id))) {
          throw new MaskedEmailError('invalidResponse');
        }
        if (result.notDestroyed && has(result.notDestroyed, id)) {
          const error = result.notDestroyed[id];
          if (!error || typeof error.type !== 'string' || (Array.isArray(result.destroyed) && result.destroyed.length)) {
            throw new MaskedEmailError('invalidResponse');
          }
          destroyAttempts.delete(id);
          throw new MaskedEmailError(error.type, error.description);
        }
        if (!Array.isArray(result.destroyed) || result.destroyed.length !== 1) throw new MaskedEmailError('invalidResponse');
        destroyAttempts.set(id, 'confirmed');
        ownedIds.delete(id);
      } catch (error) {
        if (destroyAttempts.get(id) === 'pending') {
          const type = maskedEmailErrorType(error);
          // The server answered that it did nothing: the delete can be asked again.
          if (type === 'forbidden' || type === 'notAuthenticated' || maskedEmailUnavailable(error)) {
            destroyAttempts.delete(id);
          } else {
            destroyAttempts.set(id, 'uncertain');
            throw new MaskedEmailError('deleteUnconfirmed');
          }
        }
        throw error;
      }
    },
  };
}

export type MaskedEmailManager = ReturnType<typeof createMaskedEmailManager>;
