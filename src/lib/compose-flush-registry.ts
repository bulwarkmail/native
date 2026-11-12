// The open composers, so a forced sign-out (the organisation's idle or
// session limit) can save their drafts first (webmail
// lib/compose-flush-registry.ts). A composer registers a function that
// saves its draft; a draft the server doesn't take is kept on the device
// (lib/compose-rescue.ts) and goes to Drafts after the next sign-in.

type Flush = () => Promise<unknown> | unknown;

const composers = new Map<string, Flush>();

/** Register an open composer's save; returns the unregister. */
export function registerComposerFlush(id: string, flush: Flush): () => void {
  composers.set(id, flush);
  return () => {
    if (composers.get(id) === flush) composers.delete(id);
  };
}

/** Save every open composer's draft, waiting at most `timeoutMs`. */
export async function flushComposers(timeoutMs: number): Promise<{ failed: number; timedOut: boolean }> {
  let failed = 0;
  const saves = [...composers.values()].map(async (flush) => {
    try {
      await flush();
    } catch {
      failed += 1;
    }
  });
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(saves),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return { failed, timedOut };
}
