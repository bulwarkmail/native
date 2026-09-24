// The babel plugin in scripts/babel-plugin-lucide-imports.js rewrites
// `import { X } from 'lucide-react-native'` to per-icon modules. These tests
// make sure every icon the app imports maps to a file that exists, and that
// no import form slips back to the full barrel.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const require = createRequire(import.meta.url);
const plugin = require('../../../scripts/babel-plugin-lucide-imports.js');
const babel = require('@babel/core');

const ROOT = join(__dirname, '..', '..', '..');
const PACKAGE_DIR = join(require.resolve('lucide-react-native'), '..', '..', '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') sourceFiles(p, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

const FILES = [...sourceFiles(join(ROOT, 'src')), join(ROOT, 'App.tsx'), join(ROOT, 'index.ts')];
const LUCIDE_IMPORT_RE = /import\s+(type\s+)?([^;]*?)\s+from\s+'lucide-react-native'/g;

function transform(code: string): string {
  return babel.transformSync(code, {
    babelrc: false,
    configFile: false,
    filename: 'fixture.tsx',
    parserOpts: { plugins: ['typescript', 'jsx'] },
    plugins: [plugin],
  }).code as string;
}

describe('lucide-react-native imports', () => {
  const exportMap: Map<string, { source: string; imported: string }> = plugin.loadExportMap();

  it('reads the icon table from the package barrel', () => {
    expect(exportMap.size).toBeGreaterThan(1000);
    expect(exportMap.get('Mail')?.source).toBe('lucide-react-native/dist/esm/icons/mail.js');
    // Aliases resolve to the icon they re-export.
    expect(exportMap.get('MailIcon')?.source).toBe('lucide-react-native/dist/esm/icons/mail.js');
    expect(exportMap.get('AlarmCheck')?.source).toBe('lucide-react-native/dist/esm/icons/alarm-clock-check.js');
  });

  it('maps every icon the app imports to an existing module', () => {
    const problems: string[] = [];
    let checked = 0;
    for (const file of FILES) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(LUCIDE_IMPORT_RE)) {
        const where = relative(ROOT, file);
        if (m[1]) continue; // `import type { … }` is erased
        const clause = m[2].trim();
        if (!clause.startsWith('{') || !clause.endsWith('}')) {
          problems.push(`${where}: only named imports avoid the barrel (${clause})`);
          continue;
        }
        for (const raw of clause.slice(1, -1).split(',')) {
          const spec = raw.trim();
          if (!spec || spec.startsWith('type ')) continue;
          const name = spec.split(/\s+as\s+/)[0];
          const target = exportMap.get(name);
          if (!target) {
            problems.push(`${where}: ${name} is not a lucide export (import types with \`type\`)`);
            continue;
          }
          const file = join(PACKAGE_DIR, target.source.slice('lucide-react-native/'.length));
          if (!existsSync(file)) problems.push(`${where}: ${name} -> missing ${target.source}`);
          checked++;
        }
      }
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(100);
  });

  it('rewrites named imports to per-icon modules', () => {
    const out = transform(
      "import { Mail, Trash2 as Bin, type LucideIcon, LucideProvider } from 'lucide-react-native';\n"
      + 'const icons: LucideIcon[] = [Mail, Bin];\n'
      + 'export { icons, LucideProvider };\n',
    );
    expect(out).toContain("import Mail from \"lucide-react-native/dist/esm/icons/mail.js\"");
    expect(out).toContain("import Bin from \"lucide-react-native/dist/esm/icons/trash-2.js\"");
    expect(out).toContain("import { LucideProvider } from \"lucide-react-native/dist/esm/context.js\"");
    expect(out).not.toMatch(/from "lucide-react-native"/);
  });

  it('drops type-only names and fails on unknown values', () => {
    expect(transform(
      "import { LucideProps } from 'lucide-react-native';\nexport function f(p: LucideProps) { return p; }\n",
    )).not.toContain('lucide-react-native');
    expect(() => transform(
      "import { NotAnIcon } from 'lucide-react-native';\nexport const x = NotAnIcon;\n",
    )).toThrow(/no export named "NotAnIcon"/);
  });
});
