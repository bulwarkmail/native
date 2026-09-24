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

/** Attachment descriptors for the composer's `prefillAttachments`. */
export function shareAttachments(
  share: SharePayload,
): Array<{ uri: string; name: string; type: string; size?: number }> {
  const uris = share.uris ?? [];
  return uris.map((uri, i) => {
    const mimeType = share.mimeTypes?.[i];
    const type = mimeType && !mimeType.includes('*') ? mimeType : 'application/octet-stream';
    const size = share.sizes?.[i];
    return {
      uri,
      name: share.names?.[i]?.trim() || nameFromUri(uri, i),
      type,
      ...(typeof size === 'number' && size >= 0 ? { size } : {}),
    };
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
