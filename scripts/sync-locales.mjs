// Vendor the webmail locale catalogs into ./locales/<lang>/common.json.
// Run from the RN repo root: `node scripts/sync-locales.mjs [--check] [--from <dir>]`.
//
// The webmail catalog is the source of truth and is copied verbatim. Keys the
// native app needs that the webmail does not have live in ./locales/rn/<lang>.json
// and are merged on top at runtime (src/i18n/index.ts) - they are never written
// into the vendored files, so a re-sync cannot lose them. Keys that later land
// in the webmail catalog are reported so the overlay can be trimmed.
//
// In environments where the parent repo isn't checked out (e.g. CI clone of
// the standalone RN repo), this is a no-op — vendored files stay as-is.
import { readdir, mkdir, copyFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RN_LOCALES = join(__dirname, '..', 'locales');
const RN_OVERLAYS = join(RN_LOCALES, 'rn');
// Source directory: `--from <dir>`, else $WEBMAIL_LOCALES, else the parent repo's locales.
const fromIdx = process.argv.indexOf('--from');
const fromArg = fromIdx >= 0 ? process.argv[fromIdx + 1] : undefined;
if (fromIdx >= 0 && (!fromArg || fromArg.startsWith('--'))) {
  console.error('--from needs a directory');
  process.exit(2);
}
const WEBMAIL_LOCALES = resolve(fromArg ?? process.env.WEBMAIL_LOCALES ?? join(__dirname, '..', '..', '..', 'locales'));
const CHECK_ONLY = process.argv.includes('--check');

if (!existsSync(WEBMAIL_LOCALES)) {
  console.log(`No webmail locales at ${WEBMAIL_LOCALES} — skipping (vendored files will be used).`);
  process.exit(0);
}

function flatten(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

const langs = (await readdir(WEBMAIL_LOCALES, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

let copied = 0;
let problems = 0;
for (const lang of langs) {
  const src = join(WEBMAIL_LOCALES, lang, 'common.json');
  if (!existsSync(src)) continue;
  const destDir = join(RN_LOCALES, lang);
  const dest = join(destDir, 'common.json');

  if (CHECK_ONLY) {
    if (!existsSync(dest)) {
      console.log(`missing: locales/${lang}/common.json`);
      problems++;
      continue;
    }
    const [a, b] = await Promise.all([readFile(src, 'utf8'), readFile(dest, 'utf8')]);
    if (a !== b) {
      console.log(`stale: locales/${lang}/common.json differs from the webmail`);
      problems++;
    }
  } else {
    await mkdir(destDir, { recursive: true });
    await copyFile(src, dest);
    copied++;
  }

  // Report overlay keys the webmail now ships (safe to delete from the overlay)
  // so the RN-only set stays minimal.
  const overlayPath = join(RN_OVERLAYS, `${lang}.json`);
  if (existsSync(overlayPath)) {
    const webKeys = flatten(await readJson(src));
    const overlayKeys = flatten(await readJson(overlayPath));
    const shadowed = [...overlayKeys.keys()].filter((k) => webKeys.has(k));
    if (shadowed.length > 0) {
      console.log(
        `locales/rn/${lang}.json: ${shadowed.length} key(s) now exist in the webmail catalog and shadow it:\n  ${shadowed.join('\n  ')}`,
      );
    }
  }
}

if (CHECK_ONLY) {
  console.log(problems === 0 ? 'Vendored locales are up to date.' : `${problems} locale(s) out of date.`);
  process.exit(problems === 0 ? 0 : 1);
}
console.log(`Synced ${copied} locale(s) from ${WEBMAIL_LOCALES} → ${RN_LOCALES}`);
