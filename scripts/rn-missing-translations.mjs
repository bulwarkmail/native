// List the RN-only overlay keys (locales/rn/en.json) a language has not
// translated in locales/rn/<lang>.json yet. Run from the RN repo root:
//
//   node scripts/rn-missing-translations.mjs        count per language
//   node scripts/rn-missing-translations.mjs de     the missing keys with their
//                                                   English text, as nested JSON
//
// Keys the vendored webmail catalog of that language already carries are not
// listed: they are translated there.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RN = join(ROOT, 'locales', 'rn');

function flatten(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}

function setDeep(obj, key, value) {
  const parts = key.split('.');
  let cur = obj;
  for (const part of parts.slice(0, -1)) cur = cur[part] ??= {};
  cur[parts.at(-1)] = value;
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function missingFor(lang, en) {
  const done = flatten(readJson(join(RN, `${lang}.json`)));
  const webmail = flatten(readJson(join(ROOT, 'locales', lang, 'common.json')));
  return [...en].filter(([key]) => !done.has(key) && !webmail.has(key));
}

const en = flatten(readJson(join(RN, 'en.json')));
const lang = process.argv[2];

if (lang) {
  const out = {};
  for (const [key, value] of missingFor(lang, en)) setDeep(out, key, value);
  console.log(JSON.stringify(out, null, 2));
} else {
  const langs = readdirSync(RN).filter((f) => f.endsWith('.json') && f !== 'en.json').map((f) => f.slice(0, -5));
  for (const l of langs.sort()) console.log(`${l.padEnd(6)} ${missingFor(l, en).length} of ${en.size} missing`);
}
