// Copy locale JSON files from the parent webmail repo into ./locales/.
// Run from the RN repo root: `node scripts/sync-locales.mjs`.
// In environments where the parent repo isn't checked out (e.g. CI clone of
// the standalone RN repo), this is a no-op — vendored files stay as-is.
import { readdir, mkdir, copyFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RN_LOCALES = join(__dirname, '..', 'locales');
const WEBMAIL_LOCALES = join(__dirname, '..', '..', '..', 'locales');

if (!existsSync(WEBMAIL_LOCALES)) {
  console.log(`No webmail locales at ${WEBMAIL_LOCALES} — skipping (vendored files will be used).`);
  process.exit(0);
}

async function copyDir(src, dest) {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      await copyFile(s, d);
    }
  }
}

const langs = (await readdir(WEBMAIL_LOCALES, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

let copied = 0;
for (const lang of langs) {
  const src = join(WEBMAIL_LOCALES, lang);
  const dest = join(RN_LOCALES, lang);
  await copyDir(src, dest);
  copied++;
}
console.log(`Synced ${copied} locale(s) from ${WEBMAIL_LOCALES} → ${RN_LOCALES}`);
