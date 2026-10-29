#!/usr/bin/env node
// Summarise Maestro's debug output (~/.maestro/tests) without its secrets.
//
// The JSON there records every command with its arguments, so typed
// passwords are in it; it is never uploaded. This prints, per flow, the
// command types and their status (no arguments), and for a failed command
// the element tree Maestro saw (labels, ids and bounds), which is what a
// failing selector needs. run-flows.sh scrubs the secret values from the
// output as well.
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
const out = [];

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walkFiles(p) : [p];
  });
}

function tree(node, depth, lines) {
  if (!node || typeof node !== 'object') return;
  const a = node.attributes || {};
  const label = [a.accessibilityText, a.text, a.hintText, a['resource-id'] && `#${a['resource-id']}`]
    .filter(Boolean)
    .filter((v, i, all) => all.indexOf(v) === i)
    .join(' | ');
  if (label) lines.push(`${'  '.repeat(Math.min(depth, 12))}${label} ${a.bounds || ''}${a.focused === 'true' ? ' [focused]' : ''}`);
  for (const c of node.children || []) tree(c, depth + 1, lines);
}

function findHierarchy(obj, seen = new Set()) {
  if (!obj || typeof obj !== 'object' || seen.has(obj)) return null;
  seen.add(obj);
  if (obj.attributes && Array.isArray(obj.children)) return obj;
  for (const v of Object.values(obj)) {
    const h = findHierarchy(v, seen);
    if (h) return h;
  }
  return null;
}

for (const file of walkFiles(root).filter((f) => /commands-.*\.json$/.test(f))) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    continue;
  }
  out.push(`== ${path.basename(file)}`);
  for (const entry of Array.isArray(data) ? data : []) {
    const command = entry.command || {};
    const type = Object.keys(command).find((k) => command[k]) || '?';
    const status = entry.metadata?.status || '?';
    out.push(`  ${status.padEnd(9)} ${type}`);
    if (status === 'FAILED') {
      const err = entry.metadata?.error?.message;
      if (err) out.push(`    error: ${String(err).slice(0, 300)}`);
      const h = findHierarchy(entry.metadata);
      if (h) {
        const lines = [];
        tree(h, 0, lines);
        out.push(...lines.slice(0, 250).map((l) => `    ${l}`));
      }
    }
  }
}
// Maestro 2 keeps the screen hierarchy of each failed step under
// screen-hierarchy/; it holds what the screen showed (like the screenshot).
for (const file of walkFiles(root).filter((f) => f.includes('screen-hierarchy') && f.endsWith('.json'))) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    continue;
  }
  const h = findHierarchy(data);
  if (!h) continue;
  const parts = file.split(path.sep).join('/').split('/');
  out.push(`== ${parts[parts.length - 3]} / ${parts[parts.length - 1]}`);
  const lines = [];
  tree(h, 0, lines);
  out.push(...lines.slice(0, 300).map((l) => `    ${l}`));
}
process.stdout.write(out.join('\n') + '\n');
