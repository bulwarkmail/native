// openpgp for the app (#58), loaded on first use and fixed up for Hermes.
// Load it through loadOpenPgp(), never with a bare import('openpgp').
//
// openpgp's PacketList extends Array and counts on Array methods returning a
// PacketList (Symbol.species): Message.verify does
// `packets.concat(...)` and then calls `.filterByTag()` on the result.
// Hermes does not implement Symbol.species, so concat, filter, slice and the
// rest return a plain Array there, and every decrypt or verify of a signed
// message failed with "undefined is not a function". Node and browsers
// implement it, which is why the tests never saw it.

import type * as OpenPgp from 'openpgp';

type ArraySubclass = new () => unknown[];

// The Array methods that build their result through Symbol.species.
const SPECIES_METHODS = ['concat', 'filter', 'map', 'slice', 'splice', 'flat', 'flatMap'] as const;

/**
 * Make the species-built Array methods return an instance of `Sub` on
 * instances of `Sub`, as they do on an engine with Symbol.species. On such an
 * engine the result already is one and passes through unchanged.
 */
export function keepArraySubclass(Sub: ArraySubclass): void {
  const proto = Sub.prototype as unknown as Record<string, unknown>;
  const arrayProto = Array.prototype as unknown as Record<string, (...args: unknown[]) => unknown[]>;
  for (const name of SPECIES_METHODS) {
    if (Object.prototype.hasOwnProperty.call(proto, name)) continue;
    const base = arrayProto[name];
    Object.defineProperty(proto, name, {
      configurable: true,
      writable: true,
      value: function speciesResult(this: unknown[], ...args: unknown[]): unknown[] {
        const result = base.apply(this, args);
        if ((result as object) instanceof Sub) return result;
        const out = new Sub();
        for (let i = 0; i < result.length; i++) out.push(result[i]);
        return out;
      },
    });
  }
}

/** Apply the Hermes fix-ups to a loaded openpgp module. */
export function prepareOpenPgp<T extends Pick<typeof OpenPgp, 'PacketList'>>(mod: T): T {
  keepArraySubclass(mod.PacketList as unknown as ArraySubclass);
  return mod;
}

let loading: Promise<typeof OpenPgp> | null = null;

/** openpgp, loaded once on first use and ready for Hermes. */
export function loadOpenPgp(): Promise<typeof OpenPgp> {
  if (!loading) {
    loading = import('openpgp').then(prepareOpenPgp, (err: unknown) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}
