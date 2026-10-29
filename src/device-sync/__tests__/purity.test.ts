/**
 * The device sync mappers, merge rules and engine must stay pure TypeScript:
 * no react-native, expo, zustand stores or the jmapClient singleton anywhere
 * in their import graph (docs/device-sync.md, "Architecture"). src/test-setup.ts
 * mocks those modules globally, so an impure import would not fail any other
 * test; this one walks the graph instead.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
/**
 * Modules allowed to touch React Native: the bridge wrapper, the task entry,
 * the detached client, and the app-side glue under `app/` (lifecycle,
 * triggers), which the engine never imports.
 */
const RN_BOUNDARY = new Set(['native.ts', 'task.ts', path.join('jmap', 'client-port.ts')].map((p) => path.join(ROOT, p)));
const RN_BOUNDARY_DIRS = [path.join(ROOT, 'app') + path.sep];
const isBoundary = (file: string) => RN_BOUNDARY.has(file) || RN_BOUNDARY_DIRS.some((dir) => file.startsWith(dir));

const FORBIDDEN = [
  /^react-native($|\/)/,
  /^react($|\/)/,
  /^expo/,
  /^@expo\//,
  /^zustand/,
  /^@react-native/,
  /^@react-navigation/,
];
const FORBIDDEN_FILES = [/[\\/]src[\\/]stores[\\/]/, /[\\/]api[\\/]jmap-client\.ts$/, /[\\/]lib[\\/](random|uuid)\.ts$/];

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

function specifiers(file: string): string[] {
  const src = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const out: string[] = [];
  const patterns = [
    /^\s*import\s+(?!type\s)(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm,
    /^\s*export\s+(?!type\s)[^'"]*?\s+from\s+['"]([^'"]+)['"]/gm,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      // `import { type A, type B } from` is erased too.
      const clause = m[0];
      if (/import\s*\{\s*(type\s+[\w$]+\s*,?\s*)+\}\s*from/.test(clause)) continue;
      out.push(m[1]);
    }
  }
  return out;
}

function resolve(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function impureChains(entry: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const walk = (file: string, chain: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of specifiers(file)) {
      const resolved = resolve(file, spec);
      const at = [...chain, path.relative(ROOT, file)];
      if (!resolved) {
        if (FORBIDDEN.some((re) => re.test(spec))) problems.push(`${at.join(' → ')} → ${spec}`);
        continue;
      }
      if (FORBIDDEN_FILES.some((re) => re.test(resolved))) {
        problems.push(`${at.join(' → ')} → ${path.relative(ROOT, resolved)}`);
        continue;
      }
      walk(resolved, at);
    }
  };
  walk(entry, []);
  return problems;
}

describe('device sync purity', () => {
  const entries = sourceFiles(ROOT).filter((f) => !isBoundary(f));

  it('scans the pure modules', () => {
    expect(entries.map((f) => path.relative(ROOT, f))).toEqual(expect.arrayContaining(['types.ts', path.join('common', 'json.ts')]));
  });

  it('keeps react-native, expo, stores and the jmapClient singleton out of the mappers, merge rules and engine', () => {
    const problems = entries.flatMap(impureChains);
    expect(problems).toEqual([]);
  });

  it('would catch an impure import', () => {
    const probe = path.join(ROOT, '..', 'lib', 'calendar-timezone.ts');
    expect(impureChains(probe).length).toBeGreaterThan(0);
  });
});
