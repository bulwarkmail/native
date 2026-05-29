// RFC 4122 v4 UUID generator. Prefers the platform crypto.randomUUID when
// available (Hermes/React Native 0.81 exposes it), falling back to a
// Math.random implementation. These IDs are only used as temporary client-side
// keys (e.g. parsed-vCard import rows) before the server assigns real ids, so
// the Math.random fallback's weaker entropy is acceptable.
export function generateUUID(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) {
    try {
      return c.randomUUID();
    } catch {
      // fall through to the manual implementation
    }
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
