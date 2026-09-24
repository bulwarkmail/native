import { jmapClient } from './jmap-client';
import { assertSetResult, JMAPMethodError } from './jmap-result';
import { CAPABILITIES } from './types';
import type { EmailPushConfig, PushSubscription, StateChange } from './types';

export type StateChangeHandler = (change: StateChange) => void;

// ─── PushSubscription (RFC 8620 §7.2) ───────────────────
// Mirrors the webmail's lib/jmap/client.ts push calls - keep them in sync.

// draft-ietf-jmap-emailpush (Stalwart >= 0.16.16) lets a subscription carry a
// per-account `emailPush` delivery filter. Older servers reject the capability
// in `using` and the property outright, so every call that touches it gates
// on the session advertising the capability.
function hasEmailPushCapability(): boolean {
  return jmapClient.hasCapability(CAPABILITIES.EMAIL_PUSH);
}

function pushUsing(withEmailPush: boolean): string[] {
  return withEmailPush ? [CAPABILITIES.CORE, CAPABILITIES.EMAIL_PUSH] : [CAPABILITIES.CORE];
}

export async function listPushSubscriptions(): Promise<PushSubscription[]> {
  const withEmailPush = hasEmailPushCapability();
  // `emailPush` is not in the server's default property set, so ask for it
  // explicitly - without it the stored filter never compares equal to the
  // wanted one and every launch re-patches it.
  const args: Record<string, unknown> = { ids: null };
  if (withEmailPush) {
    args.properties = ['id', 'deviceClientId', 'verificationCode', 'expires', 'types', 'emailPush'];
  }
  const res = await jmapClient.request(
    [['PushSubscription/get', args, '0']],
    pushUsing(withEmailPush),
  );
  const [, body] = res.methodResponses[0] ?? [];
  return (body?.list as PushSubscription[]) ?? [];
}

/**
 * Create a PushSubscription pointing the JMAP server at the given relay URL.
 * Returns the server-assigned id (which the client also registers with the
 * relay so the relay can route incoming pushes to an Expo token). A refusal
 * throws a JMAPMethodError carrying the server's SetError type, so callers
 * can tell a `forbidden` emailPush map from other failures.
 */
export async function createPushSubscription(params: {
  deviceClientId: string;
  url: string;
  types: string[];
  // ISO date. Servers may clamp to their own ceiling - we send the maximum we
  // want and accept whatever Stalwart returns.
  expires?: string;
  // draft-ietf-jmap-emailpush delivery filter, only when the server advertises
  // urn:ietf:params:jmap:emailpush (see serverSupportsEmailPush).
  emailPush?: Record<string, EmailPushConfig>;
}): Promise<string> {
  const created: Record<string, unknown> = {
    deviceClientId: params.deviceClientId,
    url: params.url,
    types: params.types,
  };
  if (params.expires) created.expires = params.expires;
  const withEmailPush = !!params.emailPush && hasEmailPushCapability();
  if (withEmailPush) created.emailPush = params.emailPush;

  const res = await jmapClient.request(
    [
      [
        'PushSubscription/set',
        { create: { new: created } },
        '0',
      ],
    ],
    pushUsing(withEmailPush),
  );
  const [, body] = res.methodResponses[0] ?? [];
  assertSetResult(body, ['new'], 'push subscription');
  const result = body?.created?.new as { id?: string } | undefined;
  if (!result?.id) {
    throw new Error(`PushSubscription/set create failed: ${JSON.stringify(body)}`);
  }
  return result.id;
}

/**
 * Push the subscription's expiry forward and re-sync its types or delivery
 * filter (RFC 8620 §7.2.1). Throws a JMAPMethodError carrying the server's
 * SetError type when it refuses the update - `notFound` once the
 * subscription is gone, `forbidden` for an emailPush map naming an account
 * the user may not subscribe to.
 */
export async function updatePushSubscription(
  id: string,
  patch: { expires?: string; types?: string[]; emailPush?: Record<string, EmailPushConfig> },
): Promise<void> {
  const withEmailPush = patch.emailPush !== undefined && hasEmailPushCapability();
  const update: Record<string, unknown> = { ...patch };
  if (!withEmailPush) delete update.emailPush;
  const res = await jmapClient.request(
    [
      [
        'PushSubscription/set',
        { update: { [id]: update } },
        '0',
      ],
    ],
    pushUsing(withEmailPush),
  );
  const [, body] = res.methodResponses[0] ?? [];
  assertSetResult(body, [id], 'push subscription');
  if (body?.updated?.[id] === undefined) {
    throw new JMAPMethodError('notUpdated', `PushSubscription/set did not update ${id}`);
  }
}

/**
 * Send the verification code back to the server - the call that flips the
 * subscription from pending to active (RFC 8620 §7.2.2).
 */
export async function verifyPushSubscription(
  id: string,
  verificationCode: string,
): Promise<void> {
  const res = await jmapClient.request(
    [
      [
        'PushSubscription/set',
        { update: { [id]: { verificationCode } } },
        '0',
      ],
    ],
    [CAPABILITIES.CORE],
  );
  const [, body] = res.methodResponses[0] ?? [];
  if (body?.notUpdated?.[id]) {
    throw new Error(
      `PushSubscription verification failed: ${JSON.stringify(body.notUpdated[id])}`,
    );
  }
}

export async function destroyPushSubscription(id: string): Promise<void> {
  await jmapClient.request(
    [['PushSubscription/set', { destroy: [id] }, '0']],
    [CAPABILITIES.CORE],
  );
}

// ─── Live updates ────────────────────────────────────────
// The EventSource lifecycle (reconnect with back-off, fresh bearer on every
// connect, ping watchdog, polling fallback) lives in ./push-stream. These
// re-exports keep the historical entry points.

export {
  startLiveUpdates,
  startPolling,
  type LiveUpdatesHandle,
  type LiveUpdatesOptions,
} from './push-stream';

export interface StartPushOptions {
  onStateChange: StateChangeHandler;
  onError?: (error: Error) => void;
  onFallback?: (reason: string) => void;
  isActive?: () => boolean;
}

/**
 * Start real-time updates, preferring SSE with polling fallback. Resolves to
 * a cleanup function; prefer `startLiveUpdates` when the handle's
 * `reconnect()` is needed (foreground resume).
 */
export async function startPushUpdates(
  _client: unknown,
  opts: StartPushOptions,
): Promise<() => void> {
  const { startLiveUpdates: start } = await import('./push-stream');
  try {
    const handle = await start(opts);
    return () => handle.close();
  } catch (err) {
    opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    return () => undefined;
  }
}
