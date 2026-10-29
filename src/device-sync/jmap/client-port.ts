/**
 * The JMAP side of a device sync run on the device: a `JmapPort` over a
 * detached `JMAPClient` of one registry account. Never the UI's `jmapClient`
 * singleton: a run can share the JS runtime with the UI (the headless task
 * starts with `allowedInForeground`), and re-binding the singleton would send
 * the UI's requests with another account's credentials (the widgets and the
 * push task avoid it for the same reason).
 *
 * This file is the React Native boundary of `src/device-sync/jmap`; the rest
 * of the folder is pure and runs against the fake server in tests.
 */
import { JMAPClient } from '../../api/jmap-client';
import { JMAP_CORE, type JmapCoreLimits, type JmapPort, type JmapResponse, type JmapSessionView } from '../types';
import { openWithAuthRebuild, type JmapConnection } from './connection';

/** RFC 8620 fallbacks when the server advertises no core limit. */
const FALLBACK_LIMITS: JmapCoreLimits = {
  maxObjectsInGet: 500,
  maxObjectsInSet: 500,
  maxCallsInRequest: 16,
  maxConcurrentRequests: 4,
  maxSizeRequest: 10_000_000,
};

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function coreLimits(capabilities: Record<string, unknown> | undefined): JmapCoreLimits {
  const core = (capabilities?.[JMAP_CORE] ?? {}) as Partial<Record<keyof JmapCoreLimits, unknown>>;
  return {
    maxObjectsInGet: positive(core.maxObjectsInGet, FALLBACK_LIMITS.maxObjectsInGet),
    maxObjectsInSet: positive(core.maxObjectsInSet, FALLBACK_LIMITS.maxObjectsInSet),
    maxCallsInRequest: positive(core.maxCallsInRequest, FALLBACK_LIMITS.maxCallsInRequest),
    maxConcurrentRequests: positive(core.maxConcurrentRequests, FALLBACK_LIMITS.maxConcurrentRequests),
    maxSizeRequest: positive(core.maxSizeRequest, FALLBACK_LIMITS.maxSizeRequest),
  };
}

function originOf(url: string | null): string {
  const m = /^(https?:\/\/[^/?#]+)/i.exec(url ?? '');
  return m ? m[1].toLowerCase() : (url ?? '');
}

function sessionView(client: JMAPClient): JmapSessionView {
  const session = client.currentSession;
  if (!session) throw new Error('JMAP session not loaded');
  const accounts: JmapSessionView['accounts'] = {};
  for (const [id, account] of Object.entries(session.accounts ?? {})) {
    accounts[id] = {
      name: account.name,
      isPersonal: account.isPersonal,
      isReadOnly: account.isReadOnly,
      accountCapabilities: account.accountCapabilities ?? {},
    };
  }
  return {
    username: session.username || client.username || '',
    accounts,
    primaryAccounts: session.primaryAccounts ?? {},
    capabilities: session.capabilities ?? {},
  };
}

function clientPort(client: JMAPClient): JmapPort {
  return {
    session: () => sessionView(client),
    limits: () => coreLimits(client.currentSession?.capabilities),
    request: async (calls, using) => (await client.request(calls, using)) as unknown as JmapResponse,
    downloadBlob: async (accountId, blobId, type) =>
      new Uint8Array(await client.fetchBlobArrayBuffer(blobId, undefined, type, accountId)),
  };
}

/**
 * A port for the registry account `registryId` (`AccountEntry.id`). No
 * stored credentials or rejected ones are retried once with a fresh client,
 * then fail with an AuthenticationError; an unreachable server throws a
 * NetworkError and touches nothing.
 */
export function openJmapPort(registryId: string): Promise<JmapConnection> {
  return openWithAuthRebuild(async () => {
    const client = new JMAPClient();
    if (!(await client.loadAccount(registryId))) return null;
    return { port: clientPort(client), origin: originOf(client.serverUrl) };
  });
}
