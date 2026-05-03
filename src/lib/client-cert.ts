// Bridge to the native BulwarkClientCert module. Wraps the alias pick / get /
// clear flow and exposes a `secureFetch` that mirrors the global `fetch` API
// closely enough that callers can swap them out.
//
// On non-Android platforms (or when the user has not picked a cert) we fall
// straight back to the global `fetch` so we don't pay any bridge overhead.

type Native = {
  getAlias(): Promise<string | null>;
  pickAlias(host: string | null): Promise<string | null>;
  clearAlias(): Promise<void>;
  fetchSecure(request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    bodyBase64: string | null;
    timeoutMs: number;
  }): Promise<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    bodyBase64: string;
  }>;
};

// Lazy-loaded so unit tests (which run in plain Node) don't have to parse the
// `react-native` entry point. We resolve the module on first access; the
// result is cached by the require cache.
let nativeProbed = false;
let nativeModule: Native | null = null;

function getNative(): Native | null {
  if (nativeProbed) return nativeModule;
  nativeProbed = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rn = require('react-native') as {
      Platform: { OS: string };
      NativeModules: Record<string, unknown>;
    };
    if (rn.Platform.OS !== 'android') return (nativeModule = null);
    nativeModule = (rn.NativeModules.BulwarkClientCert as Native | undefined) ?? null;
  } catch {
    nativeModule = null;
  }
  return nativeModule;
}

// Cached so the hot path can short-circuit without a bridge round-trip.
let cachedAlias: string | null | undefined;

export function isClientCertSupported(): boolean {
  return getNative() != null;
}

export async function getClientCertAlias(): Promise<string | null> {
  const native = getNative();
  if (!native) return null;
  if (cachedAlias !== undefined) return cachedAlias;
  cachedAlias = await native.getAlias();
  return cachedAlias;
}

export async function pickClientCertAlias(host: string | null): Promise<string | null> {
  const native = getNative();
  if (!native) throw new Error('Client certificates require Android');
  const alias = await native.pickAlias(host);
  cachedAlias = alias;
  return alias;
}

export async function clearClientCertAlias(): Promise<void> {
  const native = getNative();
  if (!native) return;
  await native.clearAlias();
  cachedAlias = null;
}

// ── secureFetch ───────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return globalThis.btoa ? globalThis.btoa(bin) : btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = globalThis.atob ? globalThis.atob(b64) : atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function bodyToBase64(body: BodyInit | null | undefined): Promise<string | null> {
  if (body == null) return null;
  if (typeof body === 'string') {
    // UTF-8 encode then base64.
    const encoder = new TextEncoder();
    return bytesToBase64(encoder.encode(body));
  }
  if (body instanceof ArrayBuffer) {
    return bytesToBase64(new Uint8Array(body));
  }
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    return bytesToBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  // Blob / FormData / URLSearchParams / ReadableStream are not used in the
  // current code paths. If they appear, the caller should pre-serialize.
  throw new Error(`secureFetch: unsupported body type ${(body as object).constructor?.name}`);
}

function flattenHeaders(input: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  if (Array.isArray(input)) {
    for (const [k, v] of input) out[k] = v;
    return out;
  }
  if (typeof Headers !== 'undefined' && input instanceof Headers) {
    input.forEach((v, k) => { out[k] = v; });
    return out;
  }
  return { ...(input as Record<string, string>) };
}

function buildResponse(raw: {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyBase64: string;
}): Response {
  const bytes = raw.bodyBase64 ? base64ToBytes(raw.bodyBase64) : new Uint8Array(0);
  const blob = new Blob([bytes as unknown as BlobPart]);
  return new Response(blob, {
    status: raw.status,
    statusText: raw.statusText,
    headers: raw.headers,
  });
}

/**
 * Drop-in replacement for `fetch` that routes through the native client when
 * the user has selected a client certificate. When no cert is set (or we're
 * on iOS), it just calls the platform `fetch` and the caller pays no
 * bridge overhead.
 */
export async function secureFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const native = getNative();
  if (!native) return fetch(url, init);
  const alias = await getClientCertAlias();
  if (!alias) return fetch(url, init);

  const method = init?.method ?? 'GET';
  const headers = flattenHeaders(init?.headers);
  const bodyBase64 = await bodyToBase64(init?.body);
  // Force Content-Length to come from the body bytes - some servers (Stalwart
  // behind nginx in particular) reject chunked uploads when an explicit
  // length isn't provided alongside the bytes.
  if (bodyBase64 != null) {
    const decoded = base64ToBytes(bodyBase64);
    headers['Content-Length'] = String(decoded.byteLength);
  }
  try {
    const raw = await native.fetchSecure({
      url,
      method,
      headers,
      bodyBase64,
      timeoutMs: 30_000,
    });
    return buildResponse(raw);
  } catch (err) {
    // Surface as a TypeError to mimic fetch's network-error contract; keep
    // the original message for diagnostics.
    const msg = err instanceof Error ? err.message : String(err);
    throw new TypeError(`secureFetch failed: ${msg}`);
  }
}
