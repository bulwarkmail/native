// React Native's own `URL`, the one Hermes code sees as the global, for tests
// that must hold under it as well as under Node's WHATWG `URL`. It is not
// WHATWG: the constructor appends `/` to a URL with no `?` or `#`, and
// `toString()` appends `searchParams` to the original string, so a query the
// URL already had appears twice once `searchParams` is touched.
//
// Loaded from react-native's Flow source (stripped with the Babel Expo
// already ships), with no native blob module, as on a device without one.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from '@babel/core';

const require = createRequire(import.meta.url);
const BLOB_DIR = 'react-native/Libraries/Blob/';

function load(name: string, deps: Record<string, unknown>): Record<string, unknown> {
  const filename = require.resolve(BLOB_DIR + name);
  const code = transformSync(readFileSync(filename, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename,
    plugins: ['@babel/plugin-transform-flow-strip-types', '@babel/plugin-transform-modules-commonjs'],
  })?.code;
  if (!code) throw new Error(`could not load ${name}`);
  const module = { exports: {} as Record<string, unknown> };
  new Function('require', 'module', 'exports', code)(
    (dep: string) => {
      if (!(dep in deps)) throw new Error(`${name} needs ${dep}`);
      return deps[dep];
    },
    module,
    module.exports,
  );
  return module.exports;
}

let cached: typeof URL | undefined;

export function reactNativeURL(): typeof URL {
  if (!cached) {
    const params = load('URLSearchParams.js', {});
    cached = load('URL.js', {
      './URLSearchParams': params,
      './NativeBlobModule': { __esModule: true, default: null },
    }).URL as typeof URL;
  }
  return cached;
}
