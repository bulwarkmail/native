// Translation coverage: every literal key the app passes to t() must exist in
// the merged English catalog, and every vendored locale must be a subset of
// English (the webmail catalogs are generated from en, so an extra key means
// a sync went wrong). Mirrors the webmail's translation coverage test.
import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

vi.mock('expo-localization', () => ({ getLocales: () => [] }));

import { getDictionary, SUPPORTED_LOCALES, type LocaleCode } from '../index';

const SRC_ROOT = join(__dirname, '..', '..');

function flatten(obj: Record<string, unknown>, prefix = '', out = new Set<string>()): Set<string> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v as Record<string, unknown>, key, out);
    else out.add(key);
  }
  return out;
}

// src/ plus App.tsx next to it (the tab bar and loading screen).
function sourceFiles(): string[] {
  return [...walk(SRC_ROOT), join(SRC_ROOT, '..', 'App.tsx')];
}

function walk(dir: string, out: string[] = []): string[] {
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

// Literal keys: t('a.b.c', …), or tr(…) where `t` is taken. Template-literal
// keys (`settings.tabs.${id}`) are checked by prefix below.
const LITERAL_KEY_RE = /\btr?\(\s*'([^']+)'/g;
const TEMPLATE_KEY_RE = /\btr?\(\s*`([^`$]+)\$\{/g;

// Walking and reading all of src/ synchronously takes under a second on its
// own, but went past the 5 s default (16.8 s) while gradle was building.
const SRC_WALK_TIMEOUT = 30_000;

describe('translation coverage', () => {
  const en = flatten(getDictionary('en'));

  it('every literal t() key in src exists in the English catalog', () => {
    const missing: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(LITERAL_KEY_RE)) {
        if (!en.has(m[1])) missing.push(`${m[1]}  (${relative(SRC_ROOT, file)})`);
      }
    }
    expect(missing, `keys missing from locales/en/common.json + locales/rn/en.json (run: npm run i18n:harvest):\n${missing.join('\n')}`).toEqual([]);
  }, SRC_WALK_TIMEOUT);

  it('every template t() key prefix has at least one English entry', () => {
    const missing: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(TEMPLATE_KEY_RE)) {
        const prefix = m[1];
        let found = false;
        for (const key of en) {
          if (key.startsWith(prefix)) { found = true; break; }
        }
        if (!found) missing.push(`${prefix}*  (${relative(SRC_ROOT, file)})`);
      }
    }
    expect(missing).toEqual([]);
  }, SRC_WALK_TIMEOUT);

  it('every other locale is a subset of English', () => {
    // The vendored webmail catalog, without the RN-only overlay (English is
    // complete; the other overlays are partial and fall back to it).
    const baseEn = flatten(
      JSON.parse(readFileSync(join(SRC_ROOT, '..', 'locales', 'en', 'common.json'), 'utf8')) as Record<string, unknown>,
    );
    for (const { code } of SUPPORTED_LOCALES) {
      if (code === 'en') continue;
      const keys = flatten(getDictionary(code as LocaleCode));
      const extra = [...keys].filter((k) => !en.has(k));
      expect(extra, `${code} has keys English lacks`).toEqual([]);
      // Catalogs are near-complete translations; a locale with fewer than
      // 90% of the English keys is a sign of a broken vendored file.
      expect(keys.size).toBeGreaterThan(baseEn.size * 0.9);
    }
  });
});
