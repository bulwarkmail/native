import React from 'react';
import type { ContactPhotoRef } from './contact-utils';
import {
  ContactPhotoLoad,
  contactPhotoSource,
  initialContactPhotoState,
  type ContactPhotoSource,
  type ContactPhotoState,
} from './contact-photo-loader';

export interface ContactPhotoImage {
  /**
   * The Image source, or undefined while a blob photo waits for a download
   * slot and once the photo failed to load: show the fallback then.
   */
  source: ContactPhotoSource | undefined;
  onLoad: () => void;
  onError: () => void;
}

/**
 * The source to show for a contact photo. A URI (0.16) is used as it is; a
 * blob (Stalwart 1.0) is downloaded through the queue in contact-photo-loader
 * while the component is mounted.
 */
export function useContactPhotoSource(photo: ContactPhotoRef | null | undefined): ContactPhotoImage {
  const uri = photo && 'uri' in photo ? photo.uri : undefined;
  const blob = photo && 'blobId' in photo ? photo : undefined;
  const blobId = blob?.blobId;
  const mediaType = blob?.mediaType;
  const accountId = blob?.accountId;

  // One source object per photo and credentials, so a re-render doesn't make
  // the Image load it again, while a refreshed token reaches the next load.
  const blobSourceNow = blobId ? contactPhotoSource({ blobId, mediaType, accountId }) : null;
  const auth = blobSourceNow?.headers?.Authorization;
  const key = blobSourceNow?.uri;
  const blobSource = React.useMemo(
    () => (key ? { uri: key, headers: auth ? { Authorization: auth } : undefined } : undefined),
    [key, auth],
  );
  const uriSource = React.useMemo(() => (uri ? { uri } : undefined), [uri]);

  const [failedUri, setFailedUri] = React.useState<string | null>(null);
  const [blobState, setBlobState] = React.useState<{ key?: string; state: ContactPhotoState }>(
    () => ({ key, state: key ? initialContactPhotoState(key) : 'waiting' }),
  );
  const loadRef = React.useRef<ContactPhotoLoad | null>(null);

  React.useEffect(() => {
    if (!key) return undefined;
    const load = new ContactPhotoLoad(key, (state) => setBlobState({ key, state }));
    loadRef.current = load;
    setBlobState({ key, state: load.start() });
    return () => {
      load.dispose();
      if (loadRef.current === load) loadRef.current = null;
    };
  }, [key]);

  const onLoad = React.useCallback(() => {
    loadRef.current?.loaded();
  }, []);
  const onError = React.useCallback(() => {
    if (uri) setFailedUri(uri);
    else loadRef.current?.failed();
  }, [uri]);

  if (uriSource) {
    return { source: failedUri === uri ? undefined : uriSource, onLoad, onError };
  }
  // Until the effect has started this photo's load, go by what is known of it.
  const state = blobState.key === key ? blobState.state : key ? initialContactPhotoState(key) : 'waiting';
  return { source: state === 'show' ? blobSource : undefined, onLoad, onError };
}
