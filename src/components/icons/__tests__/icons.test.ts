// The app's icons are Tabler glyphs under the names the screens import.
// These tests make sure each name draws the glyph the webmail uses for it,
// and that every icon a screen imports exists.
import { describe, it, expect, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

vi.mock('react-native-svg', () => ({ default: 'Svg', Path: 'Path' }));

const ROOT = join(__dirname, '..', '..', '..', '..');
const WEBMAIL_ICONS = join(ROOT, '..', '..', 'components', 'icons', 'index.ts');
const TABLER = join(ROOT, '..', '..', 'node_modules', '@tabler', 'icons', 'tabler-nodes-outline.json');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      // The widgets draw their own SVG strings (src/widgets/icons.ts).
      if (entry !== '__tests__' && entry !== 'node_modules' && entry !== 'widgets') sourceFiles(p, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

/** Path data the generated module hands to an icon, read off its element. */
function glyphOf(icon: unknown): string[] {
  const memo = icon as { type: (p: object) => { props: { children: { props: { d: string } }[] } } };
  return memo.type({}).props.children.map((child) => child.props.d);
}

describe('icons', () => {
  it('exports every icon a screen imports', async () => {
    const icons: Record<string, unknown> = await import('..');
    const missing: string[] = [];
    const files = [...sourceFiles(join(ROOT, 'src')), join(ROOT, 'App.tsx')];
    const re = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'[./]*(?:components\/)?icons'/g;
    let checked = 0;
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(re)) {
        for (const raw of m[1].split(',')) {
          const spec = raw.trim().replace(/^type\s+/, '');
          if (!spec) continue;
          const name = spec.split(/\s+as\s+/)[0];
          if (name === 'AppIcon' || name === 'IconProps') continue;
          checked++;
          if (typeof icons[name] !== 'object') missing.push(`${relative(ROOT, file)}: ${name}`);
        }
      }
    }
    expect(missing).toEqual([]);
    expect(checked).toBeGreaterThan(100);
  });

  it.skipIf(!existsSync(WEBMAIL_ICONS) || !existsSync(TABLER))('draws the glyph the webmail uses for the same name', async () => {
    const icons: Record<string, unknown> = await import('..');
    const tabler: Record<string, [string, { d: string }][]> = JSON.parse(readFileSync(TABLER, 'utf8'));
    const webmail = readFileSync(WEBMAIL_ICONS, 'utf8');
    const kebab = (pascal: string) => pascal.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Za-z])(\d)/g, '$1-$2').toLowerCase();
    const differ: string[] = [];
    let compared = 0;
    for (const m of webmail.matchAll(/Icon(\w+) as (\w+),/g)) {
      const [, tablerPascal, name] = m;
      if (!(name in icons)) continue;
      const expected = tabler[kebab(tablerPascal)]?.map(([, a]) => a.d);
      if (!expected) continue;
      compared++;
      if (JSON.stringify(glyphOf(icons[name])) !== JSON.stringify(expected)) differ.push(`${name} (webmail: ${kebab(tablerPascal)})`);
    }
    expect(differ).toEqual([]);
    expect(compared).toBeGreaterThan(100);
  });
});
