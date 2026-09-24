// Collect t('key', 'English fallback') calls whose key exists in neither the
// vendored webmail catalog nor the RN overlay, and add them to
// locales/rn/en.json using the inline fallback as the English text.
// Run from the RN repo root: `node scripts/harvest-rn-keys.mjs [--check]`.
// `--check` only reports (exit 1 when something is missing) - used by the
// translation coverage test message.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'src');
const EN = join(ROOT, 'locales', 'en', 'common.json');
const OVERLAY = join(ROOT, 'locales', 'rn', 'en.json');
const CHECK_ONLY = process.argv.includes('--check');

function flatten(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out.set(key, v);
  }
  return out;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

function setDeep(obj, key, value) {
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  if (cur[parts[parts.length - 1]] === undefined) cur[parts[parts.length - 1]] = value;
}

function sortDeep(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  return Object.keys(obj).sort().reduce((acc, k) => {
    acc[k] = sortDeep(obj[k]);
    return acc;
  }, {});
}

const en = flatten(JSON.parse(readFileSync(EN, 'utf8')));
const overlay = JSON.parse(readFileSync(OVERLAY, 'utf8'));
const overlayFlat = flatten(overlay);

// t('key', 'fallback') / t('key', "fallback") / t('key', `fallback`) - the
// fallback may span lines; keep it simple: single-quoted or double-quoted,
// non-nested strings. `tr` is the same function where `t` is taken (a
// template or timer variable).
const CALL_RE = /\btr?\(\s*'([^']+)'\s*,\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
const KEY_ONLY_RE = /\btr?\(\s*'([^']+)'/g;

const added = [];
const missingNoFallback = [];
for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8');
  const withFallback = new Map();
  for (const m of text.matchAll(CALL_RE)) {
    const value = (m[2] ?? m[3] ?? '').replace(/\\(['"])/g, '$1');
    if (value) withFallback.set(m[1], value);
  }
  for (const m of text.matchAll(KEY_ONLY_RE)) {
    const key = m[1];
    if (en.has(key) || overlayFlat.has(key)) continue;
    const fallback = withFallback.get(key);
    if (!fallback) {
      missingNoFallback.push(`${key}  (${relative(ROOT, file)})`);
      continue;
    }
    if (!added.some((a) => a.key === key)) added.push({ key, fallback, file: relative(ROOT, file) });
  }
}

if (added.length === 0 && missingNoFallback.length === 0) {
  console.log('All t() keys are covered.');
  process.exit(0);
}
for (const a of added) console.log(`${CHECK_ONLY ? 'missing' : 'added'}: ${a.key} = ${JSON.stringify(a.fallback)}  (${a.file})`);
for (const m of missingNoFallback) console.log(`missing (no inline fallback, add by hand): ${m}`);

if (CHECK_ONLY) process.exit(1);
for (const a of added) setDeep(overlay, a.key, a.fallback);
writeFileSync(OVERLAY, JSON.stringify(sortDeep(overlay), null, 2) + '\n');
console.log(`Wrote ${added.length} key(s) to locales/rn/en.json`);
