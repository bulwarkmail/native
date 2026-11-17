import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const at = args.indexOf('--webmail');
if (at >= 0 && (!args[at + 1] || args[at + 1].startsWith('--'))) {
  console.error('Usage: node scripts/sync-dark-mode-engine.mjs [--webmail <path>] [--check]');
  process.exit(2);
}
const WEBMAIL = resolve(at >= 0 ? args[at + 1] : join(ROOT, '..', '..'));
const CHECK_ONLY = args.includes('--check');
const SOURCE = join(WEBMAIL, 'lib', 'email-dark-mode-engine.js');
const TARGET = join(ROOT, 'src', 'lib', 'email-dark-mode.ts');

if (!existsSync(SOURCE)) {
  if (at >= 0 || CHECK_ONLY) {
    console.error(`No webmail engine at ${SOURCE}`);
    process.exit(2);
  }
  console.log(`No webmail engine at ${SOURCE}, skipping (the vendored copy stays as it is).`);
  process.exit(0);
}

// Line endings follow each checkout's git settings, not the engine: compare
// without them and write the app file back with its own.
const engineFile = readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n');
const EXPORT = 'export default ';
const from = engineFile.indexOf(EXPORT);
if (from < 0) {
  console.error(`${SOURCE}: no "${EXPORT}"`);
  process.exit(2);
}
const engine = engineFile.slice(from + EXPORT.length).trim().replace(/;$/, '');
if (engine.includes('`') || engine.includes('${')) {
  console.error(`${SOURCE}: the engine contains a backtick or a dollar-brace and can't be embedded`);
  process.exit(2);
}
const lib = new Function(`return ${engine}`)()();
if (typeof lib.apply !== 'function') {
  console.error(`${SOURCE}: does not evaluate to a factory returning { apply }`);
  process.exit(2);
}

const START = 'export const EMAIL_DARK_MODE_LIB = String.raw`';
const targetRaw = readFileSync(TARGET, 'utf8');
const eol = targetRaw.includes('\r\n') ? '\r\n' : '\n';
const target = targetRaw.replace(/\r\n/g, '\n');
const a = target.indexOf(START);
const b = a < 0 ? -1 : target.indexOf('`;', a + START.length);
if (a < 0 || b < 0) {
  console.error(`${TARGET}: EMAIL_DARK_MODE_LIB was not found`);
  process.exit(2);
}
const next = target.slice(0, a) + START + engine + target.slice(b);

if (next === target) {
  console.log(`up to date  ${TARGET}`);
} else if (CHECK_ONLY) {
  console.log(`OUT OF DATE ${TARGET} (run node scripts/sync-dark-mode-engine.mjs)`);
  process.exit(1);
} else {
  writeFileSync(TARGET, next.replace(/\n/g, eol));
  console.log(`wrote       ${TARGET}`);
}
