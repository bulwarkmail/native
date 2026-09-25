// Contact photos stored as blobs (Stalwart 1.0), shown by the platform image
// loader from the download URL with the Authorization header, the way file
// thumbnails are.
//
// Those downloads count against the same per-user budget as JMAP calls:
// Stalwart runs maxConcurrentRequests (4) requests per user at a time and
// refuses the surplus outright, and the mail list asks for a photo per sender
// row. Hence:
// - at most half of maxConcurrentRequests photo downloads run at once, so JMAP
//   calls keep the rest;
// - a photo that loaded once skips the queue: Stalwart marks downloads
//   immutable, so the image cache answers;
// - a failed download is tried once more a little later, since a refusal over
//   the limit says nothing about the photo; after that the failure is kept for
//   a while instead of retried on every render.

import { getDownloadUrl } from '../api/blob';
import { getContactsAccountId } from '../api/contacts';
import { jmapClient } from '../api/jmap-client';
import { CAPABILITIES } from '../api/types';
import type { ContactPhotoRef } from './contact-utils';

const RETRY_DELAY_MS = 1000;
const FAILURE_TTL_MS = 2 * 60_000;
const MAX_REMEMBERED = 500;

/** An Image source for a blob photo. */
export interface ContactPhotoSource {
  uri: string;
  headers?: Record<string, string>;
}

type BlobPhoto = Extract<ContactPhotoRef, { blobId: string }>;

/**
 * The download URL and Authorization header of a blob photo, or null while
 * there is no session to build them from.
 */
export function contactPhotoSource(photo: BlobPhoto): ContactPhotoSource | null {
  try {
    const accountId = photo.accountId || getContactsAccountId();
    return {
      uri: getDownloadUrl(photo.blobId, 'photo', photo.mediaType || 'application/octet-stream', accountId),
      headers: { Authorization: jmapClient.authHeader },
    };
  } catch {
    return null;
  }
}

/** Photo downloads allowed at once: half the server's request budget. */
export function photoDownloadLimit(): number {
  const core = jmapClient.currentSession?.capabilities?.[CAPABILITIES.CORE] as
    | { maxConcurrentRequests?: unknown }
    | undefined;
  const max = typeof core?.maxConcurrentRequests === 'number' && core.maxConcurrentRequests > 0
    ? core.maxConcurrentRequests
    : 4;
  return Math.max(1, Math.floor(max / 2));
}

/** A counting semaphore for photo downloads, first come first served. */
export class PhotoDownloadGate {
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: () => number) {}

  /**
   * Calls `start` once a download slot is free. The returned function frees
   * the slot again, or drops the request while it still waits; calling it
   * more than once is harmless.
   */
  acquire(start: () => void): () => void {
    let state: 'queued' | 'running' | 'done' = 'queued';
    const run = () => {
      state = 'running';
      this.running++;
      start();
    };
    if (this.running < this.limit()) run();
    else this.queue.push(run);
    return () => {
      if (state === 'done') return;
      if (state === 'queued') {
        const at = this.queue.indexOf(run);
        if (at >= 0) this.queue.splice(at, 1);
      } else {
        this.running--;
      }
      state = 'done';
      this.pump();
    };
  }

  private pump(): void {
    while (this.running < this.limit() && this.queue.length > 0) {
      this.queue.shift()!();
    }
  }
}

const photoDownloads = new PhotoDownloadGate(photoDownloadLimit);

// Download URLs of photos the image loader has shown (oldest first), and of
// photos that failed twice, with when to try them again.
const loadedPhotos = new Set<string>();
const failedUntil = new Map<string, number>();

function rememberLoaded(key: string): void {
  loadedPhotos.delete(key);
  loadedPhotos.add(key);
  if (loadedPhotos.size > MAX_REMEMBERED) {
    loadedPhotos.delete(loadedPhotos.values().next().value as string);
  }
}

function recentlyFailed(key: string): boolean {
  const until = failedUntil.get(key);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  failedUntil.delete(key);
  return false;
}

/**
 * `waiting`: queued for a download slot (show the fallback); `show`: render
 * the image; `failed`: show the fallback, the photo can't be loaded now.
 */
export type ContactPhotoState = 'waiting' | 'show' | 'failed';

/** What a photo shows before its load starts: known photos show at once. */
export function initialContactPhotoState(key: string): ContactPhotoState {
  if (loadedPhotos.has(key)) return 'show';
  if (recentlyFailed(key)) return 'failed';
  return 'waiting';
}

/** One image of a blob photo on screen, from queueing to loaded or failed. */
export class ContactPhotoLoad {
  private state: ContactPhotoState = 'waiting';
  private release: (() => void) | null = null;
  private retried = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly key: string,
    private readonly onChange: (state: ContactPhotoState) => void,
    private readonly gate: PhotoDownloadGate = photoDownloads,
  ) {}

  /** Starts loading and returns the state to show now. */
  start(): ContactPhotoState {
    this.state = initialContactPhotoState(this.key);
    if (this.state === 'waiting') this.enqueue();
    return this.state;
  }

  /** The image loaded: from now on it comes from the image cache. */
  loaded(): void {
    rememberLoaded(this.key);
    this.freeSlot();
  }

  /** The image failed to load: try once more later, then give up for a while. */
  failed(): void {
    this.freeSlot();
    loadedPhotos.delete(this.key);
    if (this.disposed) return;
    if (!this.retried) {
      this.retried = true;
      this.set('waiting');
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (!this.disposed) this.enqueue();
      }, RETRY_DELAY_MS);
      return;
    }
    failedUntil.set(this.key, Date.now() + FAILURE_TTL_MS);
    this.set('failed');
  }

  /** The image left the screen: give its slot to the next photo. */
  dispose(): void {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.freeSlot();
  }

  private enqueue(): void {
    this.state = 'waiting';
    this.release = this.gate.acquire(() => this.set('show'));
  }

  private set(state: ContactPhotoState): void {
    if (this.disposed || state === this.state) return;
    this.state = state;
    this.onChange(state);
  }

  private freeSlot(): void {
    const release = this.release;
    this.release = null;
    release?.();
  }
}

/** Forgets which photos loaded or failed (tests). */
export function resetContactPhotoLoads(): void {
  loadedPhotos.clear();
  failedUntil.clear();
}
