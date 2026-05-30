// Stalwart account-security management. Mirrors the webmail's
// stores/account-security-store.ts, talking to Stalwart's JMAP extension
// methods (x:AccountPassword, x:AppPassword, x:ApiKey, x:AccountSettings,
// x:Account). The webmail proxies these through a server-side passthrough so
// the basic-auth header stays in an httpOnly cookie; the mobile client already
// holds its own credentials, so it calls the JMAP endpoint directly with the
// `urn:stalwart:jmap` capability in `using`.

import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';

const STALWART_CAPABILITY = 'urn:stalwart:jmap';
const STALWART_USING = [CAPABILITIES.CORE, STALWART_CAPABILITY];

export type EncryptionType = 'Disabled' | 'Aes128' | 'Aes256';

export interface AppCredentialInfo {
  id: string;
  description: string;
  createdAt: string | null;
  expiresAt: string | null;
  allowedIps: string[];
}

export type AppPasswordInfo = AppCredentialInfo;
export type ApiKeyInfo = AppCredentialInfo;

export interface AppCredentialInput {
  description: string;
  expiresAt?: string | null;
  allowedIps?: string[];
}

export interface AuthInfo {
  otpEnabled: boolean;
  appPasswords: AppPasswordInfo[];
  apiKeys: ApiKeyInfo[];
}

export interface PrincipalInfo {
  displayName: string;
  emails: string[];
  quota: number;
  roles: string[];
}

type MethodResponse = [string, Record<string, any>, string];

// True once a live session advertises Stalwart's JMAP extension. Without it
// none of the x:* methods exist, so the screen shows a "not available" notice.
export function isStalwartSupported(): boolean {
  const session = jmapClient.currentSession;
  if (!session) return false;
  return STALWART_CAPABILITY in (session.capabilities ?? {});
}

// Pull a single method response out by its call id and throw on a JMAP method
// error (the `['error', {type, description}, id]` envelope).
function resultFor<T = Record<string, any>>(responses: MethodResponse[], callId: string): T {
  const match = responses.find((r) => r[2] === callId);
  if (!match) throw new Error(`Missing JMAP response for call ${callId}`);
  if (match[0] === 'error') {
    const err = match[1] as { type?: string; description?: string };
    throw new Error(err.description || err.type || 'JMAP error');
  }
  return match[1] as T;
}

async function send(methodCalls: [string, Record<string, unknown>, string][]): Promise<MethodResponse[]> {
  const res = await jmapClient.request(methodCalls, STALWART_USING);
  return res.methodResponses as MethodResponse[];
}

function credentialFromResult(raw: Record<string, unknown>): AppCredentialInfo {
  const allowedIps =
    raw.allowedIps && typeof raw.allowedIps === 'object'
      ? Object.keys(raw.allowedIps as Record<string, unknown>)
      : [];
  return {
    id: String(raw.id ?? ''),
    description: typeof raw.description === 'string' ? raw.description : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : null,
    allowedIps,
  };
}

function ipsToMap(ips?: string[]): Record<string, true> | undefined {
  if (!ips || ips.length === 0) return undefined;
  return Object.fromEntries(ips.map((ip) => [ip, true]));
}

function buildCreateBody(input: AppCredentialInput): Record<string, unknown> {
  const body: Record<string, unknown> = { description: input.description };
  if (input.expiresAt) body.expiresAt = input.expiresAt;
  const allowed = ipsToMap(input.allowedIps);
  if (allowed) body.allowedIps = allowed;
  return body;
}

function extractEncryptionType(raw: unknown): EncryptionType {
  if (!raw || typeof raw !== 'object') return 'Disabled';
  const type = (raw as { ['@type']?: string })['@type'];
  if (type === 'Aes128' || type === 'Aes256') return type;
  return 'Disabled';
}

// ── Reads ─────────────────────────────────────────────────

export async function fetchAuthInfo(): Promise<AuthInfo> {
  const accountId = jmapClient.accountId;
  const responses = await send([
    ['x:AccountPassword/get', { accountId, ids: ['singleton'] }, 'p'],
    ['x:AppPassword/query', { accountId }, 'aq'],
    ['x:ApiKey/query', { accountId }, 'kq'],
  ]);

  const passwordResult = resultFor<{ list?: Array<{ otpAuth?: { otpUrl?: string | null } }> }>(responses, 'p');
  const appPwQuery = resultFor<{ ids?: string[] }>(responses, 'aq');
  const apiKeyQuery = resultFor<{ ids?: string[] }>(responses, 'kq');

  const otpAuth = passwordResult.list?.[0]?.otpAuth;
  const otpEnabled = !!(otpAuth && typeof otpAuth === 'object' && otpAuth.otpUrl);

  const followUps: [string, Record<string, unknown>, string][] = [];
  if (appPwQuery.ids?.length) {
    followUps.push(['x:AppPassword/get', { accountId, ids: appPwQuery.ids }, 'app']);
  }
  if (apiKeyQuery.ids?.length) {
    followUps.push(['x:ApiKey/get', { accountId, ids: apiKeyQuery.ids }, 'key']);
  }

  let appPasswords: AppPasswordInfo[] = [];
  let apiKeys: ApiKeyInfo[] = [];
  if (followUps.length) {
    const followUpResponses = await send(followUps);
    if (appPwQuery.ids?.length) {
      const r = resultFor<{ list?: Array<Record<string, unknown>> }>(followUpResponses, 'app');
      appPasswords = (r.list ?? []).map(credentialFromResult);
    }
    if (apiKeyQuery.ids?.length) {
      const r = resultFor<{ list?: Array<Record<string, unknown>> }>(followUpResponses, 'key');
      apiKeys = (r.list ?? []).map(credentialFromResult);
    }
  }

  return { otpEnabled, appPasswords, apiKeys };
}

export async function fetchEncryptionType(): Promise<EncryptionType> {
  const accountId = jmapClient.accountId;
  const responses = await send([['x:AccountSettings/get', { accountId, ids: ['singleton'] }, '0']]);
  const result = resultFor<{ list?: Array<{ encryptionAtRest?: unknown }> }>(responses, '0');
  return extractEncryptionType(result.list?.[0]?.encryptionAtRest);
}

export async function fetchPrincipal(): Promise<PrincipalInfo> {
  const accountId = jmapClient.accountId;
  const responses = await send([['x:Account/get', { accountId, ids: [accountId] }, '0']]);
  const result = resultFor<{
    list?: Array<{
      description?: string | null;
      aliases?: Record<string, { name?: string; enabled?: boolean }>;
      quotas?: { maxDiskQuota?: number };
      roles?: { ['@type']?: string };
      name?: string;
    }>;
  }>(responses, '0');

  const acc = result.list?.[0];
  const aliasAddresses = acc?.aliases
    ? Object.values(acc.aliases).flatMap((a) => (a && a.enabled !== false && a.name ? [a.name] : []))
    : [];
  const primaryEmail = acc?.name ? [acc.name] : [];
  return {
    displayName: acc?.description ?? '',
    emails: [...primaryEmail, ...aliasAddresses],
    quota: acc?.quotas?.maxDiskQuota ?? 0,
    roles: acc?.roles?.['@type'] ? [acc.roles['@type']] : [],
  };
}

// ── Mutations ─────────────────────────────────────────────

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const accountId = jmapClient.accountId;
  const responses = await send([
    [
      'x:AccountPassword/set',
      { accountId, update: { singleton: { currentSecret: currentPassword, secret: newPassword } } },
      '0',
    ],
  ]);
  const result = resultFor<{ notUpdated?: Record<string, { description?: string; type?: string }> }>(responses, '0');
  const failure = result.notUpdated?.singleton;
  if (failure) throw new Error(failure.description || failure.type || 'Failed to change password');
}

export async function updateDisplayName(displayName: string): Promise<void> {
  const accountId = jmapClient.accountId;
  const responses = await send([
    ['x:AccountSettings/set', { accountId, update: { singleton: { description: displayName } } }, '0'],
  ]);
  const result = resultFor<{ notUpdated?: Record<string, { description?: string; type?: string }> }>(responses, '0');
  const failure = result.notUpdated?.singleton;
  if (failure) throw new Error(failure.description || failure.type || 'Failed to update display name');
}

export async function enableTotp(currentPassword: string, otpUrl: string, otpCode: string): Promise<void> {
  const accountId = jmapClient.accountId;
  const responses = await send([
    [
      'x:AccountPassword/set',
      { accountId, update: { singleton: { currentSecret: currentPassword, otpAuth: { otpUrl, otpCode } } } },
      '0',
    ],
  ]);
  const result = resultFor<{ notUpdated?: Record<string, { description?: string; type?: string }> }>(responses, '0');
  const failure = result.notUpdated?.singleton;
  if (failure) throw new Error(failure.description || failure.type || 'Failed to enable two-factor authentication');
}

export async function disableTotp(currentPassword: string): Promise<void> {
  const accountId = jmapClient.accountId;
  const responses = await send([
    [
      'x:AccountPassword/set',
      { accountId, update: { singleton: { currentSecret: currentPassword, otpAuth: { otpUrl: null } } } },
      '0',
    ],
  ]);
  const result = resultFor<{ notUpdated?: Record<string, { description?: string; type?: string }> }>(responses, '0');
  const failure = result.notUpdated?.singleton;
  if (failure) throw new Error(failure.description || failure.type || 'Failed to disable two-factor authentication');
}

type SetMethod = 'x:AppPassword/set' | 'x:ApiKey/set';

async function createCredential(method: SetMethod, input: AppCredentialInput): Promise<{ id: string; secret: string }> {
  const accountId = jmapClient.accountId;
  const tmpId = 'new';
  const responses = await send([[method, { accountId, create: { [tmpId]: buildCreateBody(input) } }, '0']]);
  const result = resultFor<{
    created?: Record<string, { id: string; secret: string }>;
    notCreated?: Record<string, { type?: string; description?: string }>;
  }>(responses, '0');

  const notCreated = result.notCreated?.[tmpId];
  if (notCreated) throw new Error(notCreated.description || notCreated.type || 'Failed to create credential');
  const created = result.created?.[tmpId];
  if (!created?.id || !created.secret) throw new Error('Server did not return the created credential');
  return { id: created.id, secret: created.secret };
}

async function removeCredential(method: SetMethod, id: string): Promise<void> {
  const accountId = jmapClient.accountId;
  const responses = await send([[method, { accountId, destroy: [id] }, '0']]);
  const result = resultFor<{ notDestroyed?: Record<string, { description?: string; type?: string }> }>(responses, '0');
  const failure = result.notDestroyed?.[id];
  if (failure) throw new Error(failure.description || failure.type || 'Failed to remove credential');
}

export function createAppPassword(input: AppCredentialInput): Promise<{ id: string; secret: string }> {
  return createCredential('x:AppPassword/set', input);
}

export function removeAppPassword(id: string): Promise<void> {
  return removeCredential('x:AppPassword/set', id);
}

export function createApiKey(input: AppCredentialInput): Promise<{ id: string; secret: string }> {
  return createCredential('x:ApiKey/set', input);
}

export function removeApiKey(id: string): Promise<void> {
  return removeCredential('x:ApiKey/set', id);
}
