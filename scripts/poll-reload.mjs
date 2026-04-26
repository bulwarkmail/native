import { readdir, stat } from 'node:fs/promises';
import { watchFile } from 'node:fs';
import { join, extname } from 'node:path';

const ROOTS = ['src', 'App.tsx', 'index.ts', 'app.json'];
const EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json']);
const INTERVAL = 500;
const METRO = 'http://localhost:8081/reload';

async function* walk(p) {
  const s = await stat(p).catch(() => null);
  if (!s) return;
  if (s.isFile()) { yield p; return; }
  for (const e of await readdir(p, { withFileTypes: true })) {
    const f = join(p, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      yield* walk(f);
    } else if (e.isFile() && EXTS.has(extname(e.name))) {
      yield f;
    }
  }
}

let pending = false;
async function reload(file) {
  if (pending) return;
  pending = true;
  try {
    console.log(`change: ${file}`);
    const r = await fetch(METRO, { method: 'GET' });
    console.log(`reload -> ${r.status}`);
  } catch (e) {
    console.log(`reload failed: ${e.message}`);
  }
  setTimeout(() => { pending = false; }, 500);
}

const files = [];
for (const r of ROOTS) {
  for await (const f of walk(r)) files.push(f);
}
console.log(`watching ${files.length} files (poll ${INTERVAL}ms)`);
for (const f of files) {
  watchFile(f, { interval: INTERVAL }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) reload(f);
  });
}
