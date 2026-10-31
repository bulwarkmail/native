import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// With edge-to-edge on, every RN Modal on Android reaches under the
// navigation bar (a tablet's taskbar, a phone's gesture bar). Bottom sheets
// that ended at the screen edge without padding for it put their last row
// under the taskbar on a Pixel Tablet: New folder's Save and Cancel, the
// Files item actions' Delete and Delete permanently. A tap there opened an
// app from the taskbar instead. Every sheet surface inside a plain Modal pads
// its bottom by the inset (useSheetBottomInset, or insets.bottom).

const SRC = path.resolve(__dirname, '../..');

// Sheets in files other agents own; their fix is reported, not made here.
const OWNED_ELSEWHERE = new Set([
  'components/SidebarDrawer.tsx',
  'components/calendar/CalendarEditSheet.tsx',
  'components/sharing/ShareCollectionSheet.tsx',
]);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(p);
    return e.name.endsWith('.tsx') ? [p] : [];
  });
}

/** What is between each plain <Modal ...> and its </Modal>. */
function modalBodies(source: string): string[] {
  const out: string[] = [];
  const re = /<Modal[\s>]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const end = source.indexOf('</Modal>', m.index);
    out.push(source.slice(m.index, end < 0 ? undefined : end));
  }
  return out;
}

/** A body that renders a bottom sheet surface (styles.sheet / styles.modalSheet). */
function rendersSheet(body: string): boolean {
  return /styles\.(sheet|modalSheet)\b/.test(body);
}

function padsBottom(body: string): boolean {
  return /bottomInset|insets\.bottom/.test(body);
}

describe('bottom sheets in a Modal', () => {
  it('pad their content above the navigation bar or taskbar', () => {
    const offenders = sourceFiles(SRC).flatMap((file) => {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (OWNED_ELSEWHERE.has(rel)) return [];
      const source = fs.readFileSync(file, 'utf8');
      return modalBodies(source)
        .filter((body) => rendersSheet(body) && !padsBottom(body))
        .map(() => rel);
    });
    expect(offenders).toEqual([]);
  });

  it('covers the sheets the tablet walkthrough found', () => {
    for (const rel of ['components/settings/FolderSettings.tsx', 'screens/FilesScreen.tsx', 'components/files/ShareSheet.tsx']) {
      const bodies = modalBodies(fs.readFileSync(path.join(SRC, rel), 'utf8')).filter(rendersSheet);
      expect(bodies.length, rel).toBeGreaterThan(0);
    }
  });

  it('finds the sheet in a Modal body', () => {
    const src = '<Modal visible transparent>\n<View style={[styles.sheet, { paddingBottom: bottomInset }]} />\n</Modal>';
    const bodies = modalBodies(src);
    expect(bodies).toHaveLength(1);
    expect(rendersSheet(bodies[0])).toBe(true);
    expect(padsBottom(bodies[0])).toBe(true);
    expect(padsBottom('<Modal><View style={styles.sheet} /></Modal>')).toBe(false);
  });
});
