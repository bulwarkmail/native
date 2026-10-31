import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// A ScrollView without keyboardShouldPersistTaps eats the first tap while the
// keyboard is up: it only closes the keyboard. React Native's responder walks
// the React tree, so a ScrollView around a <Modal> also swallows the first tap
// on the sheet's Save button (Settings > Folders > New folder on the tablet,
// where the page sits in the split pane's ScrollView). No renderer in the test
// env, so this checks every scroll container in the settings, calendar sheets,
// files and sharing code.

const SRC = path.resolve(__dirname, '..', '..', '..');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walk(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

// The calendar grids hold no inputs and open their sheets as siblings.
const GRIDS = new Set(['MonthScrollView.tsx', 'TimeGridScrollView.tsx', 'WeekView.tsx', 'AgendaView.tsx']);

const files = [
  path.join(SRC, 'screens', 'SettingsScreen.tsx'),
  path.join(SRC, 'screens', 'FilesScreen.tsx'),
  ...walk(path.join(SRC, 'components', 'settings')),
  ...walk(path.join(SRC, 'components', 'calendar')).filter((f) => !GRIDS.has(path.basename(f))),
  ...walk(path.join(SRC, 'components', 'files')),
  ...walk(path.join(SRC, 'components', 'sharing')),
];

/** The opening JSX tags of every scroll container in `src`. */
function scrollTags(src: string): string[] {
  const tags: string[] = [];
  // Not a type argument such as useRef<ScrollView>.
  const re = /(?<![\w.])<(ScrollView|FlatList|SectionList|Animated\.ScrollView)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 0;
    let i = m.index + m[0].length;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) break;
    }
    tags.push(src.slice(m.index, i + 1));
  }
  return tags;
}

describe('keyboardShouldPersistTaps on scroll containers', () => {
  it('finds the opening tag across lines and arrow functions', () => {
    const tags = scrollTags('<FlatList\n  renderItem={({ item }) => <Row />}\n  keyboardShouldPersistTaps="handled"\n/>');
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain('keyboardShouldPersistTaps');
    expect(scrollTags('const ref = React.useRef<ScrollView>(null);')).toHaveLength(0);
  });

  it.each(files.map((f) => [path.relative(SRC, f), f]))('%s', (_name, file) => {
    const src = fs.readFileSync(file, 'utf8');
    for (const tag of scrollTags(src)) {
      expect(tag, `${path.basename(file)}: ${tag.split('\n')[0]}`).toMatch(/keyboardShouldPersistTaps="(handled|always)"/);
    }
  });
});
