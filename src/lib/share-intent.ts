import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import type { SharePayload } from '../navigation/linking';

// Android share sheet (ACTION_SEND / ACTION_SEND_MULTIPLE) → composer.
// MainActivity stashes the intent in ShareIntentStore; JS drains it here on
// launch and listens for later shares while running.

type ShareNative = {
  getInitialShare?: () => Promise<SharePayload | null>;
};

function native(): ShareNative | null {
  if (Platform.OS !== 'android') return null;
  return ((NativeModules as Record<string, unknown>).BulwarkFcm as ShareNative | undefined) ?? null;
}

export async function getInitialShare(): Promise<SharePayload | null> {
  const mod = native();
  if (!mod?.getInitialShare) return null;
  try {
    return (await mod.getInitialShare()) ?? null;
  } catch {
    return null;
  }
}

export function addShareListener(listener: (payload: SharePayload) => void): () => void {
  if (Platform.OS !== 'android' || !NativeModules.BulwarkFcm) return () => undefined;
  const emitter = new NativeEventEmitter(NativeModules.BulwarkFcm);
  const sub = emitter.addListener('app:share', listener);
  return () => sub.remove();
}

// The app's package names, the GitHub and the Play flavour. A provider of
// either belongs to the app, whichever build is running. Keep in sync with
// OWN_PACKAGES in ShareIntentStore.kt.
const OWN_PACKAGES = ['com.anonymous.bulwarkmobile', 'org.bulwarkmail.mobile'];

/**
 * Whether a file another app shares into this one may be attached: a
 * `content:` address whose provider isn't one of the app's own. Anything
 * else (`file:`, a bare path, `http:`) can name the app's private files,
 * which this app can read and the sending app can't. The authority is read
 * as Android resolves it: percent-decoded, without a `<user>@` in front or
 * a port, in any case. Same rule as ShareIntentStore.isForeignContentUri.
 */
export function isForeignContentUri(uri: string): boolean {
  const match = /^content:\/\/([^/?#]*)/i.exec(uri);
  if (!match) return false;
  let authority: string;
  try {
    authority = decodeURIComponent(match[1]);
  } catch {
    return false;
  }
  authority = authority.slice(authority.lastIndexOf('@') + 1).split(':')[0].trim().toLowerCase();
  if (!authority) return false;
  return !OWN_PACKAGES.some((pkg) => authority === pkg || authority.startsWith(`${pkg}.`));
}

/**
 * Attachment descriptors for the composer's `prefillAttachments`: only the
 * files isForeignContentUri accepts, each with its own name, type and size.
 */
export function shareAttachments(
  share: SharePayload,
): Array<{ uri: string; name: string; type: string; size?: number }> {
  const uris = share.uris ?? [];
  return uris.flatMap((uri, i) => {
    if (!isForeignContentUri(uri)) return [];
    const mimeType = share.mimeTypes?.[i];
    const type = mimeType && !mimeType.includes('*') ? mimeType : 'application/octet-stream';
    const size = share.sizes?.[i];
    return [{
      uri,
      name: share.names?.[i]?.trim() || nameFromUri(uri, i),
      type,
      ...(typeof size === 'number' && size >= 0 ? { size } : {}),
    }];
  });
}

function nameFromUri(uri: string, i: number): string {
  const last = uri.split('/').filter(Boolean).pop() ?? `shared-${i + 1}`;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}
