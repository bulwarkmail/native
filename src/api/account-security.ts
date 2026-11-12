// Stalwart account-security management. Mirrors the webmail's
// stores/account-security-store.ts, talking to Stalwart's JMAP extension
// methods (x:AccountPassword, x:AppPassword, x:ApiKey, x:AccountSettings,
// x:Account). The webmail proxies these through a server-side passthrough so
// the basic-auth header stays in an httpOnly cookie; the mobile client already
// holds its own credentials, so it calls the JMAP endpoint directly with the
// `urn:stalwart:jmap` capability in `using`.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import { generateAccountId } from '../lib/account-utils';

// The account-management extension: Stalwart's, or Inbuxa's registry, which
// takes the same x:* methods (webmail lib/stalwart/management-capability.ts).
const MANAGEMENT_CAPABILITIES = ['urn:stalwart:jmap', 'urn:inbuxa:jmap:registry'] as const;
export type ManagementCapability = typeof MANAGEMENT_CAPABILITIES[number];

/** The management capability the signed-in account lists, or null. */
export function getManagementCapability(): ManagementCapability | null {
  return MANAGEMENT_CAPABILITIES.find((capability) => jmapClient.hasAccountCapability(capability)) ?? null;
}

/**
 * Encryption at rest as the server names it. 0.16, 1.0.0 and 1.0.1 have a
 * cipher per account (`Aes128`, `Aes256`); 1.0.2 has none and calls it
 * `Enabled` (and switched every account to `Disabled` on the upgrade).
 */
export type EncryptionType = 'Disabled' | 'Aes128' | 'Aes256' | 'Enabled';

/**
 * Which of the two forms the server takes: `cipher` (0.16 to 1.0.1),
 * `enabled` (1.0.2+), or null while nothing has told yet.
 */
export type EncryptionDialect = 'cipher' | 'enabled' | null;

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

export interface CryptoInfo {
  type: EncryptionType;
  /**
   * Told by the setting's own form, or while it is off by the discovery
   * document's Stalwart scopes (1.0.3+); null when neither tells.
   */
  dialect: EncryptionDialect;
  publicKeyId: string | null;
  encryptOnAppend: boolean;
  allowSpamTraining: boolean;
  /** 1.0.2's `headerProtection`, kept as read so a save doesn't reset it. */
  headerProtection?: unknown;
  /**
   * It was on when this phone last read it and is off now, and not by a
   * change made here: a server update to 1.0.2 does that.
   */
  turnedOffOnServer?: boolean;
}

export interface PublicKeyInfo {
  id: string;
  description: string;
  emailAddresses: string[];
  createdAt: string | null;
  expiresAt: string | null;
  // Key material (PEM / armored). Only returned by some server versions.
  key?: string;
  /** Stalwart 1.0.2+ reads the key's options back (`authenticatedEncryption`). */
  hasKeyOptions?: boolean;
}

export interface PublicKeyInput {
  description: string;
  key: string;
  emailAddresses?: string[];
  expiresAt?: string | null;
}

export interface PrincipalInfo {
  displayName: string;
  emails: string[];
  quota: number;
  roles: string[];
}

type MethodResponse = [string, Record<string, any>, string];

// True once a live session advertises Stalwart's JMAP extension (or Inbuxa's
// registry). Without it none of the x:* methods exist, so the screen shows a
// "not available" notice. Stalwart lists `urn:stalwart:jmap` only under the
// account's `accountCapabilities` (verified on 0.16.19), never at session
// level, so the account-level map is what has to be checked (native #47).
export function isStalwartSupported(): boolean {
  const session = jmapClient.currentSession;
  if (!session || !jmapClient.isConnected) return false;
  return getManagementCapability() !== null;
}

/**
 * The server refused an x:* method to this sign-in. Stalwart 1.0.0 to 1.0.2
 * give the account's own settings (password, two-factor, app passwords, API
 * keys, encryption) only to first-party clients. 1.0.3 has none and gives
 * them by scope: `security` (password, two-factor, app passwords, API keys,
 * grants), `settings` (account settings, public keys, masked addresses) or
 * `full` (everything). A token without them reaches mail, contacts,
 * calendars and files, and every x:* call answers `forbidden`. Basic auth
 * and 0.16 tokens are not limited.
 */
export class AccountSecurityForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountSecurityForbiddenError';
  }
}

/**
 * Signed in to Stalwart 1.0 through the client the app registered itself,
 * with a token that reaches no x:* object: on 1.0.0 to 1.0.2 any such
 * token, on 1.0.3+ one without the `security`, `settings` or `full` scope
 * (a grant from before the upgrade). The session then lists no Stalwart
 * extension either (checked on 1.0.0; 1.0.3 lists it only to tokens with
 * one of those scopes), which is not the same as a server without it.
 * Stalwart's registered client ids are `swc1.` sealed ids.
 */
export function isLimitedStalwartSignIn(): boolean {
  const clientId = jmapClient.oauthClientId;
  return !!clientId && clientId.startsWith('swc1.') && !isStalwartSupported() && !!jmapClient.currentSession;
}

const STALWART_SECURITY_SCOPE = 'urn:stalwart:oauth:scope:security';

/**
 * Does the server give these settings to a sign-in that asks for them?
 * Stalwart 1.0.3+ does, through the `security` scope it lists in its
 * discovery document; a grant from before the upgrade keeps its data-only
 * scopes, and signing in again gets a new one.
 */
export async function serverOffersSecurityScope(): Promise<boolean> {
  const serverUrl = jmapClient.serverUrl;
  if (!serverUrl) return false;
  try {
    const { discoverOAuthMetadata } = await import('../lib/oauth-native');
    const metadata = await discoverOAuthMetadata(serverUrl);
    return !!metadata?.scopes_supported?.includes(STALWART_SECURITY_SCOPE);
  } catch {
    return false;
  }
}

const STALWART_SCOPE_PREFIX = 'urn:stalwart:oauth:scope:';

/**
 * Is the server Stalwart 1.0.3 or later? Its discovery document lists
 * Stalwart's own scopes (`urn:stalwart:oauth:scope:security` and the
 * like), which 0.16 and 1.0.0 to 1.0.2 don't. Encryption at rest reads back
 * `Disabled` the same on all of them, so this is what tells 1.0.3+ (no
 * cipher, only `Enabled`) apart while it is off and no key says so. 1.0.2
 * stays unknown here; a save there finds out (updateEncryptionAtRest).
 */
async function serverListsStalwartScopes(): Promise<boolean> {
  const serverUrl = jmapClient.serverUrl;
  if (!serverUrl) return false;
  try {
    const { discoverOAuthMetadata } = await import('../lib/oauth-native');
    const metadata = await discoverOAuthMetadata(serverUrl);
    return !!metadata?.scopes_supported?.some((s) => typeof s === 'string' && s.startsWith(STALWART_SCOPE_PREFIX));
  } catch {
    return false;
  }
}

/**
 * Did the user sign in with the account's Stalwart password? Basic auth, or
 * the password + TOTP sign-in, which ends in tokens (Stalwart takes no TOTP
 * over Basic auth). Only then are a password change and turning TOTP off
 * the user's to make here; a browser or webmail sign-in may have gone
 * through another identity provider.
 */
export async function signedInWithPassword(): Promise<boolean> {
  if (!jmapClient.usesBearerAuth) return true;
  const username = jmapClient.username;
  const serverUrl = jmapClient.serverUrl;
  if (!username || !serverUrl) return false;
  const tokens = await jmapClient.getStoredOAuthTokens(generateAccountId(username, serverUrl)).catch(() => null);
  return tokens?.source === 'totp';
}

// Pull a single method response out by its call id and throw on a JMAP method
// error (the `['error', {type, description}, id]` envelope).
function resultFor<T = Record<string, any>>(responses: MethodResponse[], callId: string): T {
  const match = responses.find((r) => r[2] === callId);
  if (!match) throw new Error(`Missing JMAP response for call ${callId}`);
  if (match[0] === 'error') {
    const err = match[1] as { type?: string; description?: string };
    const message = err.description || err.type || 'JMAP error';
    if (err.type === 'forbidden') throw new AccountSecurityForbiddenError(message);
    throw new Error(message);
  }
  return match[1] as T;
}

/** An x:* request with the account's management capability (also masked-email.ts). */
export async function send(methodCalls: [string, Record<string, unknown>, string][]): Promise<MethodResponse[]> {
  const res = await jmapClient.request(methodCalls, [CAPABILITIES.CORE, getManagementCapability() ?? 'urn:stalwart:jmap']);
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
  if (type === 'Aes128' || type === 'Aes256' || type === 'Enabled') return type;
  return 'Disabled';
}

/**
 * The form a save must use: what the setting says, else what the public
 * keys say (1.0.2 reads back `authenticatedEncryption` on every key), else
 * null, and the save finds out (updateEncryptionAtRest).
 */
export function encryptionDialect(info: Pick<CryptoInfo, 'dialect'>, keys: PublicKeyInfo[]): EncryptionDialect {
  if (info.dialect) return info.dialect;
  return keys.some((k) => k.hasKeyOptions) ? 'enabled' : null;
}

// Per account: encryption at rest was on when last read here, so that an
// upgrade switching it off can be told (CryptoInfo.turnedOffOnServer).
const ENCRYPTION_ON_KEY = 'bulwark.encryptionAtRest.wasOn:';

function encryptionMemoryKey(): string | null {
  const username = jmapClient.username;
  const serverUrl = jmapClient.serverUrl;
  return username && serverUrl ? `${ENCRYPTION_ON_KEY}${generateAccountId(username, serverUrl)}` : null;
}

async function rememberEncryptionOn(on: boolean): Promise<void> {
  const key = encryptionMemoryKey();
  if (!key) return;
  try {
    if (on) await AsyncStorage.setItem(key, '1');
    else await AsyncStorage.removeItem(key);
  } catch {
    // only a hint
  }
}

// ── Reads ─────────────────────────────────────────────────

export async function fetchAuthInfo(): Promise<AuthInfo> {
  const accountId = jmapClient.accountId;
  const responses = await send([
    ['x:AccountPassword/get', { accountId, ids: ['singleton'] }, 'p'],
    ['x:AppPassword/query', { accountId }, 'aq'],
    ['x:ApiKey/query', { accountId }, 'kq'],
  ]);

  const passwordResult = resultFor<{
    list?: Array<{ otpAuth?: { otpUrl?: string | null }; otpUrl?: string | null }>;
  }>(responses, 'p');
  const appPwQuery = resultFor<{ ids?: string[] }>(responses, 'aq');
  const apiKeyQuery = resultFor<{ ids?: string[] }>(responses, 'kq');

  // x:AccountPassword nests the TOTP URL in `otpAuth` on 0.16 and 1.0. 1.0's
  // PasswordCredential (the admin's view of the same secret) has it as a
  // top-level `otpUrl` instead, so take either.
  const entry = passwordResult.list?.[0];
  const otpAuth = entry?.otpAuth;
  const otpEnabled = !!(otpAuth && typeof otpAuth === 'object' && otpAuth.otpUrl)
    || (typeof entry?.otpUrl === 'string' && !!entry.otpUrl);

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
  return (await fetchCryptoInfo()).type;
}

export async function fetchCryptoInfo(): Promise<CryptoInfo> {
  const accountId = jmapClient.accountId;
  const responses = await send([['x:AccountSettings/get', { accountId, ids: ['singleton'] }, '0']]);
  const result = resultFor<{ list?: Array<{ encryptionAtRest?: unknown }> }>(responses, '0');
  const raw = (result.list?.[0]?.encryptionAtRest ?? {}) as {
    publicKey?: string | null;
    encryptOnAppend?: boolean;
    allowSpamTraining?: boolean;
    headerProtection?: unknown;
  };
  const type = extractEncryptionType(result.list?.[0]?.encryptionAtRest);
  let turnedOffOnServer = false;
  const memoryKey = encryptionMemoryKey();
  if (type === 'Disabled') {
    if (memoryKey) turnedOffOnServer = (await AsyncStorage.getItem(memoryKey).catch(() => null)) === '1';
  } else {
    await rememberEncryptionOn(true);
  }
  let dialect: EncryptionDialect = type === 'Enabled' ? 'enabled' : type === 'Disabled' ? null : 'cipher';
  if (dialect === null && (await serverListsStalwartScopes())) dialect = 'enabled';
  return {
    type,
    dialect,
    publicKeyId: typeof raw.publicKey === 'string' ? raw.publicKey : null,
    encryptOnAppend: raw.encryptOnAppend === true,
    allowSpamTraining: raw.allowSpamTraining === true,
    ...(raw.headerProtection !== undefined ? { headerProtection: raw.headerProtection } : {}),
    ...(turnedOffOnServer ? { turnedOffOnServer } : {}),
  };
}

async function setEncryptionAtRest(payload: Record<string, unknown>): Promise<void> {
  const accountId = jmapClient.accountId;
  const responses = await send([
    ['x:AccountSettings/set', { accountId, update: { singleton: { encryptionAtRest: payload } } }, '0'],
  ]);
  const result = resultFor<{ notUpdated?: Record<string, { description?: string; type?: string }> }>(responses, '0');
  const failure = result.notUpdated?.singleton;
  if (failure) throw new Error(failure.description || failure.type || 'Failed to update encryption settings');
}

/**
 * Configure Stalwart's encryption at rest (`x:AccountSettings/set`
 * `encryptionAtRest`). Turning it on needs a public key id from
 * {@link fetchPublicKeys}; `encryptOnAppend` also encrypts mail the user
 * files (imported or appended over IMAP), `allowSpamTraining` lets the
 * classifier read a message before it is encrypted. Since Stalwart 1.0.1
 * JMAP drafts (`$draft`) and the Sent copy of a JMAP submission are stored
 * unencrypted, so they stay editable and go out readable; 0.16 and 1.0.0
 * encrypted those too.
 *
 * `Aes128`/`Aes256` is the form of 0.16 to 1.0.1, `Enabled` that of 1.0.2+.
 * Where the form isn't known (`dialect` null), a refused cipher is tried
 * again as `Enabled`, and the first refusal is reported if that fails too.
 */
export async function updateEncryptionAtRest(input: {
  type: EncryptionType;
  publicKeyId?: string | null;
  encryptOnAppend?: boolean;
  allowSpamTraining?: boolean;
  headerProtection?: unknown;
  dialect?: EncryptionDialect;
}): Promise<void> {
  if (input.type === 'Disabled') {
    await setEncryptionAtRest({ '@type': 'Disabled' });
    await rememberEncryptionOn(false);
    return;
  }
  if (!input.publicKeyId) throw new Error('A public key is required to enable encryption');
  const settings = {
    publicKey: input.publicKeyId,
    encryptOnAppend: input.encryptOnAppend ?? false,
    allowSpamTraining: input.allowSpamTraining ?? false,
  };
  const enabled = {
    '@type': 'Enabled',
    ...settings,
    ...(input.headerProtection !== undefined ? { headerProtection: input.headerProtection } : {}),
  };
  if (input.type === 'Enabled' || input.dialect === 'enabled') {
    await setEncryptionAtRest(enabled);
  } else {
    try {
      await setEncryptionAtRest({ '@type': input.type, ...settings });
    } catch (err) {
      if (input.dialect === 'cipher' || err instanceof AccountSecurityForbiddenError) throw err;
      try {
        await setEncryptionAtRest(enabled);
      } catch {
        throw err;
      }
    }
  }
  await rememberEncryptionOn(true);
}

function publicKeyFromResult(raw: Record<string, unknown>): PublicKeyInfo {
  const emails =
    raw.emailAddresses && typeof raw.emailAddresses === 'object'
      ? Object.keys(raw.emailAddresses as Record<string, unknown>)
      : [];
  return {
    id: String(raw.id ?? ''),
    description: typeof raw.description === 'string' ? raw.description : '',
    emailAddresses: emails,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : null,
    key: typeof raw.key === 'string' ? raw.key : undefined,
    ...(typeof raw.authenticatedEncryption === 'boolean' || typeof raw.strictKeyWrapEncoding === 'boolean'
      ? { hasKeyOptions: true }
      : {}),
  };
}

/** S/MIME certificates and PGP public keys stored on the server (`x:PublicKey`). */
export async function fetchPublicKeys(): Promise<PublicKeyInfo[]> {
  const accountId = jmapClient.accountId;
  const queryResponses = await send([['x:PublicKey/query', { accountId }, '0']]);
  const query = resultFor<{ ids?: string[] }>(queryResponses, '0');
  if (!query.ids?.length) return [];
  const getResponses = await send([['x:PublicKey/get', { accountId, ids: query.ids }, '0']]);
  const got = resultFor<{ list?: Array<Record<string, unknown>> }>(getResponses, '0');
  return (got.list ?? []).map(publicKeyFromResult);
}

/**
 * Adds an S/MIME certificate or PGP key. Stalwart 1.0.2+ reads the
 * addresses and the expiry from the key itself and refuses a create that
 * sets them ("Cannot modify server set property"); 0.16 and 1.0.1 take them
 * and default to none. So they go along only when the caller has them, and
 * a create the server refuses for them is sent again without them.
 */
export async function createPublicKey(input: PublicKeyInput): Promise<string> {
  const accountId = jmapClient.accountId;
  const tmpId = 'new';
  const base: Record<string, unknown> = { description: input.description, key: input.key };
  const extra: Record<string, unknown> = {};
  const addresses = ipsToMap(input.emailAddresses);
  if (addresses) extra.emailAddresses = addresses;
  if (input.expiresAt) extra.expiresAt = input.expiresAt;

  const attempt = async (payload: Record<string, unknown>) => {
    const responses = await send([['x:PublicKey/set', { accountId, create: { [tmpId]: payload } }, '0']]);
    return resultFor<{
      created?: Record<string, { id: string }>;
      notCreated?: Record<string, { type?: string; description?: string }>;
    }>(responses, '0');
  };
  let result = await attempt({ ...base, ...extra });
  const refused = result.notCreated?.[tmpId];
  if (refused && Object.keys(extra).length && /server set property/i.test(refused.description ?? '')) {
    result = await attempt(base);
  }
  const notCreated = result.notCreated?.[tmpId];
  if (notCreated) throw new Error(notCreated.description || notCreated.type || 'Failed to add public key');
  const created = result.created?.[tmpId];
  if (!created?.id) throw new Error('Server did not return the created public key');
  return created.id;
}

export async function removePublicKey(id: string): Promise<void> {
  const accountId = jmapClient.accountId;
  const responses = await send([['x:PublicKey/set', { accountId, destroy: [id] }, '0']]);
  const result = resultFor<{ notDestroyed?: Record<string, { description?: string; type?: string }> }>(responses, '0');
  const failure = result.notDestroyed?.[id];
  if (failure) throw new Error(failure.description || failure.type || 'Failed to remove public key');
}

/**
 * The account's "Full name": the `description` of `x:AccountSettings`, which
 * every user can read (webmail #900). Null when it is not set.
 */
export async function fetchAccountDisplayName(): Promise<string | null> {
  const accountId = jmapClient.accountId;
  const responses = await send([['x:AccountSettings/get', { accountId, ids: ['singleton'] }, '0']]);
  const result = resultFor<{ list?: Array<{ description?: string | null }> }>(responses, '0');
  const description = result.list?.[0]?.description;
  return typeof description === 'string' && description.trim() ? description.trim() : null;
}

// Stalwart only lets admins read their own principal with x:Account/get;
// everyone else is refused, every time. A refusal is remembered per account
// for the session, so the alias lookups don't keep asking.
const PRINCIPAL_REFUSALS = new Set(['forbidden', 'unknownMethod', 'accountNotSupportedByMethod']);
const principalRefused = new Set<string>();

function principalKey(accountId: string): string {
  return `${jmapClient.serverUrl ?? ''}|${accountId}`;
}

/** Test hook. */
export function resetPrincipalRefusals(): void {
  principalRefused.clear();
}

export async function fetchPrincipal(): Promise<PrincipalInfo> {
  const accountId = jmapClient.accountId;
  const key = principalKey(accountId);
  if (principalRefused.has(key)) throw new Error('forbidden');
  const responses = await send([['x:Account/get', { accountId, ids: [accountId] }, '0']]);
  const refusal = responses.find((r) => r[2] === '0' && r[0] === 'error')?.[1] as { type?: string } | undefined;
  if (refusal?.type && PRINCIPAL_REFUSALS.has(refusal.type)) principalRefused.add(key);
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

/**
 * With TOTP on, Stalwart wants the current code for any password or OTP
 * change ("Current OTP code is required to change the password or OTP
 * auth."; a wrong code reads "Current secret is incorrect."). Patch only
 * `otpAuth/otpCode`: a whole `otpAuth` object would reset `otpUrl` and turn
 * TOTP off. The property is `otpAuth` on 0.16 and 1.0 alike (checked on
 * 0.16.27 and 1.0.0).
 */
function otpCodePatch(otpCode: string | undefined): Record<string, string> {
  const code = otpCode?.trim();
  return code ? { 'otpAuth/otpCode': code } : {};
}

/** `otpCode` is required once TOTP is on. */
export async function changePassword(currentPassword: string, newPassword: string, otpCode?: string): Promise<void> {
  const accountId = jmapClient.accountId;
  const responses = await send([
    [
      'x:AccountPassword/set',
      {
        accountId,
        update: { singleton: { currentSecret: currentPassword, secret: newPassword, ...otpCodePatch(otpCode) } },
      },
      '0',
    ],
  ]);
  const result = resultFor<{ notUpdated?: Record<string, { description?: string; type?: string }> }>(responses, '0');
  const failure = result.notUpdated?.singleton;
  if (failure) throw new Error(failure.description || failure.type || 'Failed to change password');
  // The stored credential must follow, otherwise the next request 401s and
  // the next launch evicts the account.
  await jmapClient.updatePassword(newPassword);
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

/** Stalwart asks for a current code to turn TOTP off, like any OTP change. */
export async function disableTotp(currentPassword: string, otpCode?: string): Promise<void> {
  const accountId = jmapClient.accountId;
  const code = otpCode?.trim();
  const responses = await send([
    [
      'x:AccountPassword/set',
      {
        accountId,
        update: { singleton: { currentSecret: currentPassword, otpAuth: { otpUrl: null, ...(code ? { otpCode: code } : {}) } } },
      },
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
