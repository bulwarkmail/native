import { vi } from 'vitest';
import type { SieveScript } from '../../sieve/types';

/**
 * In-memory Sieve accounts behind the api/sieve functions. Every call names
 * the account it acts on; a call for an account that was never made throws,
 * so a test sees a write that went to the wrong script.
 */
export function mockSieveAccount(
  accountId: string,
  initial: Array<{ id?: string; name: string; content: string; isActive: boolean }> = [],
  extensions: string[] = ['fileinto', 'mailbox', 'mailboxid', 'imap4flags', 'include', 'copy', 'spamtestplus', 'relational'],
) {
  let nextId = 1;
  let nextBlob = 1;
  const blobs = new Map<string, string>();
  const scripts: SieveScript[] = initial.map((s) => {
    const blobId = `${accountId}-blob-${nextBlob++}`;
    blobs.set(blobId, s.content);
    return { id: s.id ?? `${accountId}-script-${nextId++}`, name: s.name, blobId, isActive: s.isActive };
  });
  const setActive = (id: string | null) => {
    for (const s of scripts) s.isActive = s.id === id;
  };

  const api = {
    getSieveCapabilities: vi.fn(() => ({ sieveExtensions: extensions }) as never),
    getSieveScripts: vi.fn(async () => scripts.map((s) => ({ ...s }))),
    getSieveScriptContent: vi.fn(async (blobId: string) => blobs.get(blobId) ?? ''),
    updateSieveScript: vi.fn(async (id: string, content: string, activate?: boolean) => {
      const script = scripts.find((s) => s.id === id);
      if (!script) throw new Error('notFound');
      const blobId = `${accountId}-blob-${nextBlob++}`;
      blobs.set(blobId, content);
      script.blobId = blobId;
      if (activate) setActive(id);
    }),
    createSieveScript: vi.fn(async (name: string, content: string, activate?: boolean) => {
      const blobId = `${accountId}-blob-${nextBlob++}`;
      blobs.set(blobId, content);
      const script = { id: `${accountId}-script-${nextId++}`, name, blobId, isActive: false };
      scripts.push(script);
      if (activate) setActive(script.id);
      return { ...script };
    }),
    deleteSieveScript: vi.fn(async (id: string) => {
      const index = scripts.findIndex((s) => s.id === id);
      if (index === -1) throw new Error('notFound');
      if (scripts[index].isActive) throw new Error('scriptIsActive');
      scripts.splice(index, 1);
    }),
    activateSieveScript: vi.fn(async (id: string) => { setActive(id); }),
    deactivateSieveScript: vi.fn(async () => { setActive(null); }),
  };

  return {
    id: accountId,
    api,
    scripts,
    /** The content of the named script, or of the active one. */
    content(name?: string): string {
      const script = name ? scripts.find((s) => s.name === name) : scripts.find((s) => s.isActive);
      return script ? blobs.get(script.blobId) ?? '' : '';
    },
    active(): string | null {
      return scripts.find((s) => s.isActive)?.name ?? null;
    },
    writes(): number {
      return api.updateSieveScript.mock.calls.length + api.createSieveScript.mock.calls.length
        + api.deleteSieveScript.mock.calls.length + api.activateSieveScript.mock.calls.length
        + api.deactivateSieveScript.mock.calls.length;
    },
  };
}

export type MockSieveAccount = ReturnType<typeof mockSieveAccount>;

/** A connection the mock API checks each scoped call against (see OpScope). */
export function mockConnection(initialGen = 1) {
  let gen = initialGen;
  return {
    get gen() { return gen; },
    /** Another connection takes over: calls on the old one stop, as jmapClient's do. */
    replace() { gen++; },
  };
}

export type MockConnection = ReturnType<typeof mockConnection>;

/** jmapClient's StaleLoadError, as isStaleLoad knows it (by name). */
export class MockStaleLoadError extends Error {
  constructor() {
    super('Superseded by a newer account load');
    this.name = 'StaleLoadError';
  }
}

/**
 * Routes api/sieve calls to the registered accounts by their explicit
 * account. A missing account (a call that fell back to the default account)
 * or an unknown one throws. With a connection, every call must carry a
 * scope (`{ gen, accountId }`), and one from a connection that was replaced
 * throws StaleLoadError before it reaches the account, as jmapClient does.
 */
export function sieveRouter(options: { connection?: MockConnection } = {}) {
  const accounts = new Map<string, MockSieveAccount>();
  const writeCounts = new Map<string, number>();
  const pick = (ref: unknown): MockSieveAccount => {
    let accountId: unknown = ref;
    if (options.connection) {
      const scope = ref as { gen?: unknown; accountId?: unknown } | undefined;
      if (!scope || typeof scope !== 'object' || typeof scope.gen !== 'number') {
        throw new Error(`call without a connection scope: ${String(ref)}`);
      }
      if (scope.gen !== options.connection.gen) throw new MockStaleLoadError();
      accountId = scope.accountId;
    } else if (ref && typeof ref === 'object') {
      accountId = (ref as { accountId?: unknown }).accountId;
    }
    const account = typeof accountId === 'string' ? accounts.get(accountId) : undefined;
    if (!account) throw new Error(`call for unknown or missing account ${String(accountId)}`);
    return account;
  };
  // The account a write is for, counted once it passed the checks.
  const write = (ref: unknown): MockSieveAccount => {
    const account = pick(ref);
    writeCounts.set(account.id, (writeCounts.get(account.id) ?? 0) + 1);
    return account;
  };
  return {
    register(account: MockSieveAccount) { accounts.set(account.id, account); return account; },
    reset() { accounts.clear(); writeCounts.clear(); },
    pick,
    /** Script writes made through the module for `accountId` (Stalwart's own switching left out). */
    writes(accountId: string): number { return writeCounts.get(accountId) ?? 0; },
    module: {
      getSieveCapabilities: (a?: unknown) => pick(a).api.getSieveCapabilities(),
      getSieveScripts: (a?: unknown) => pick(a).api.getSieveScripts(),
      getSieveScriptContent: (blobId: string, a?: unknown) => pick(a).api.getSieveScriptContent(blobId),
      updateSieveScript: (id: string, c: string, act?: boolean, a?: unknown) => write(a).api.updateSieveScript(id, c, act),
      createSieveScript: (n: string, c: string, act?: boolean, a?: unknown) => write(a).api.createSieveScript(n, c, act),
      deleteSieveScript: (id: string, a?: unknown) => write(a).api.deleteSieveScript(id),
      activateSieveScript: (id: string, a?: unknown) => write(a).api.activateSieveScript(id),
      deactivateSieveScript: (a?: unknown) => write(a).api.deactivateSieveScript(),
    },
  };
}

export type SieveRouter = ReturnType<typeof sieveRouter>;

export const STALWART_VACATION_SCRIPT = 'require "vacation";\nvacation "Ich bin nicht da.";\n';

interface VacationFields {
  fromDate: string | null;
  toDate: string | null;
  subject: string;
  textBody: string;
  htmlBody: string | null;
}

/**
 * A Sieve account that behaves like Stalwart for VacationResponse (webmail
 * lib/filters/__tests__/sieve-mock.ts): turning the auto-reply on activates
 * its own "vacation" script, which switches every other script off, and it
 * reads as on only while that script is the active one. Like Stalwart, an
 * update that leaves isEnabled out switches that script off, and one
 * redirect per message is the default limit. Its `vacation` calls go through
 * the router's checks like the Sieve ones.
 */
export function mockStalwartAccount(
  router: SieveRouter,
  accountId: string,
  initial: Parameters<typeof mockSieveAccount>[1],
  extensions: string[],
  options: { maxNumberRedirects?: number; vacation?: Partial<VacationFields> } = {},
) {
  const account = router.register(mockSieveAccount(accountId, initial, extensions));
  let vacation: VacationFields = { fromDate: null, toDate: null, subject: '', textBody: 'away', htmlBody: null, ...options.vacation };
  const maxNumberRedirects = 'maxNumberRedirects' in options ? options.maxNumberRedirects : 1;
  account.api.getSieveCapabilities.mockImplementation(() => ({ sieveExtensions: extensions, maxNumberRedirects }) as never);
  const vacationApi = {
    getVacationResponse: vi.fn(async (a?: unknown) => {
      router.pick(a);
      return { id: 'singleton', ...vacation, isEnabled: account.active() === 'vacation' };
    }),
    setVacationResponse: vi.fn(async (updates: Record<string, unknown>, a?: unknown) => {
      router.pick(a);
      const { isEnabled, ...fields } = updates;
      vacation = { ...vacation, ...fields };
      if (isEnabled === true) {
        const own = account.scripts.find((s) => s.name === 'vacation');
        if (own) await account.api.activateSieveScript(own.id);
        else await account.api.createSieveScript('vacation', STALWART_VACATION_SCRIPT, true);
      } else if (account.active() === 'vacation') {
        await account.api.deactivateSieveScript();
      }
    }),
  };
  return {
    ...account,
    vacation: vacationApi,
    /** Script writes the client made (Stalwart's own switching of its vacation script left out). */
    writes: () => router.writes(accountId),
  };
}
