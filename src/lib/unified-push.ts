import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

// Thin JS surface over the BulwarkUnifiedPush native module. UnifiedPush
// (https://unifiedpush.org) delivers pushes through a user-installed
// distributor app (ntfy, NextPush, ...) instead of Google Play services -
// the transport for de-Googled devices. Incoming messages themselves are
// dispatched natively through the same headless task / `fcm:message` event
// as FCM, so only registration management lives here.

export interface UnifiedPushEndpoint {
  url: string;
  // RFC 8291 Web Push keys from the connector; null with legacy distributors,
  // in which case the relay falls back to plain (unencrypted ping) delivery.
  p256dh: string | null;
  auth: string | null;
}

type BulwarkUnifiedPushNative = {
  getDistributors(): Promise<string[]>;
  getSavedDistributor(): Promise<string | null>;
  getAckDistributor(): Promise<string | null>;
  saveDistributor(distributor: string): Promise<void>;
  register(vapid: string | null): Promise<void>;
  unregister(): Promise<void>;
  getEndpoint(): Promise<UnifiedPushEndpoint | null>;
};

function getNative(): BulwarkUnifiedPushNative | null {
  if (Platform.OS !== 'android') return null;
  return (
    ((NativeModules as Record<string, unknown>).BulwarkUnifiedPush as
      | BulwarkUnifiedPushNative
      | undefined) ?? null
  );
}

/** True when the app build carries the UnifiedPush connector (Android only). */
export function isUnifiedPushSupported(): boolean {
  return getNative() !== null;
}

/** Package names of the distributor apps installed on this device. */
export async function getUnifiedPushDistributors(): Promise<string[]> {
  const native = getNative();
  if (!native) return [];
  try {
    return await native.getDistributors();
  } catch {
    return [];
  }
}

export async function getSavedUnifiedPushDistributor(): Promise<string | null> {
  const native = getNative();
  if (!native) return null;
  try {
    return await native.getSavedDistributor();
  } catch {
    return null;
  }
}

export async function saveUnifiedPushDistributor(distributor: string): Promise<void> {
  const native = getNative();
  if (!native) throw new Error('UnifiedPush is not available on this platform.');
  await native.saveDistributor(distributor);
}

export async function getUnifiedPushEndpoint(): Promise<UnifiedPushEndpoint | null> {
  const native = getNative();
  if (!native) return null;
  try {
    return await native.getEndpoint();
  } catch {
    return null;
  }
}

export async function unregisterUnifiedPush(): Promise<void> {
  const native = getNative();
  if (!native) return;
  await native.unregister().catch(() => undefined);
}

function emitter(): NativeEventEmitter {
  return new NativeEventEmitter(NativeModules.BulwarkUnifiedPush);
}

/**
 * Fires whenever the distributor hands out a (new) endpoint - including
 * rotations while the app runs. Callers re-register the endpoint with the
 * relay, mirroring the FCM token-refresh listener.
 */
export function addUnifiedPushEndpointListener(
  listener: (endpoint: UnifiedPushEndpoint) => void,
): () => void {
  if (!isUnifiedPushSupported()) return () => undefined;
  const sub = emitter().addListener('up:newEndpoint', listener);
  return () => sub.remove();
}

export function addUnifiedPushUnregisteredListener(listener: () => void): () => void {
  if (!isUnifiedPushSupported()) return () => undefined;
  const sub = emitter().addListener('up:unregistered', listener);
  return () => sub.remove();
}

export class UnifiedPushRegisterError extends Error {
  // 'no-distributor' - nothing installed; 'choose-distributor' - several
  // installed and none selected yet; 'failed' - the distributor rejected or
  // never answered the registration.
  readonly reason: 'no-distributor' | 'choose-distributor' | 'failed';

  constructor(reason: UnifiedPushRegisterError['reason'], message: string) {
    super(message);
    this.name = 'UnifiedPushRegisterError';
    this.reason = reason;
  }
}

/**
 * Register with the saved distributor (auto-selecting it when exactly one is
 * installed) and resolve with the endpoint. The endpoint arrives as an async
 * event from the distributor; a previously stored endpoint short-circuits the
 * wait - if the distributor then rotates it, the up:newEndpoint listener
 * re-runs setup with the fresh one.
 */
export async function registerUnifiedPush(params: {
  vapid?: string | null;
  timeoutMs?: number;
}): Promise<UnifiedPushEndpoint> {
  const native = getNative();
  if (!native) {
    throw new UnifiedPushRegisterError('failed', 'UnifiedPush is not available on this platform.');
  }

  const distributors = await getUnifiedPushDistributors();
  if (distributors.length === 0) {
    throw new UnifiedPushRegisterError(
      'no-distributor',
      'No UnifiedPush distributor app is installed. Install one (for example ntfy) and try again.',
    );
  }
  let saved = await getSavedUnifiedPushDistributor();
  if (!saved || !distributors.includes(saved)) {
    if (distributors.length > 1) {
      throw new UnifiedPushRegisterError(
        'choose-distributor',
        'Several UnifiedPush distributors are installed - choose one in the notification settings.',
      );
    }
    saved = distributors[0];
    await native.saveDistributor(saved);
  }

  const timeoutMs = params.timeoutMs ?? 30_000;
  return new Promise<UnifiedPushEndpoint>((resolve, reject) => {
    let settled = false;
    const cleanups: Array<() => void> = [];
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      for (const c of cleanups) c();
      fn();
    };

    const epSub = emitter().addListener('up:newEndpoint', (endpoint: UnifiedPushEndpoint) => {
      finish(() => resolve(endpoint));
    });
    cleanups.push(() => epSub.remove());
    const failSub = emitter().addListener(
      'up:registrationFailed',
      (payload: { reason?: string }) => {
        finish(() =>
          reject(
            new UnifiedPushRegisterError(
              'failed',
              `The distributor rejected the registration (${payload?.reason ?? 'unknown'}).`,
            ),
          ),
        );
      },
    );
    cleanups.push(() => failSub.remove());
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new UnifiedPushRegisterError(
            'failed',
            `The distributor did not provide an endpoint within ${Math.round(timeoutMs / 1000)} s.`,
          ),
        ),
      );
    }, timeoutMs);
    cleanups.push(() => clearTimeout(timer));

    void native
      .register(params.vapid ?? null)
      .then(async () => {
        // A re-registration usually keeps the existing endpoint, and the
        // distributor may not re-announce it - use the stored one if present.
        const stored = await native.getEndpoint().catch(() => null);
        if (stored) finish(() => resolve(stored));
      })
      .catch((err: unknown) => {
        finish(() =>
          reject(
            new UnifiedPushRegisterError(
              'failed',
              err instanceof Error ? err.message : String(err),
            ),
          ),
        );
      });
  });
}
