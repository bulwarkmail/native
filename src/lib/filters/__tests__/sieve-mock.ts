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
      if (scripts[index]?.isActive) throw new Error('scriptIsActive');
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

/**
 * Routes api/sieve calls to the registered accounts by their explicit
 * accountId. A missing accountId (a call that fell back to the default
 * account) or an unknown one throws.
 */
export function sieveRouter() {
  const accounts = new Map<string, MockSieveAccount>();
  const pick = (accountId: unknown): MockSieveAccount => {
    const account = typeof accountId === 'string' ? accounts.get(accountId) : undefined;
    if (!account) throw new Error(`call for unknown or missing account ${String(accountId)}`);
    return account;
  };
  return {
    register(account: MockSieveAccount) { accounts.set(account.id, account); return account; },
    reset() { accounts.clear(); },
    module: {
      getSieveCapabilities: (a?: string) => pick(a).api.getSieveCapabilities(),
      getSieveScripts: (a?: string) => pick(a).api.getSieveScripts(),
      getSieveScriptContent: (blobId: string, a?: string) => pick(a).api.getSieveScriptContent(blobId),
      updateSieveScript: (id: string, c: string, act?: boolean, a?: string) => pick(a).api.updateSieveScript(id, c, act),
      createSieveScript: (n: string, c: string, act?: boolean, a?: string) => pick(a).api.createSieveScript(n, c, act),
      deleteSieveScript: (id: string, a?: string) => pick(a).api.deleteSieveScript(id),
      activateSieveScript: (id: string, a?: string) => pick(a).api.activateSieveScript(id),
      deactivateSieveScript: (a?: string) => pick(a).api.deactivateSieveScript(),
    },
  };
}
