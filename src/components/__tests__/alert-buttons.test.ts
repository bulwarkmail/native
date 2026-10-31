// An Android alert shows at most three buttons and drops the rest. The Files
// tab's recent-file menu was an Alert with Open, Show in folder, Remove from
// recent and Cancel: Cancel fell off, and since an Android alert also ignores
// Back and outside taps, the menu could only be left by picking an action.
// Menus with more than three choices are sheets.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** Each Alert.alert(...) call with its arguments. */
function alertCalls(source: string): { call: string; line: number }[] {
  const out: { call: string; line: number }[] = [];
  let at = source.indexOf('Alert.alert(');
  while (at >= 0) {
    let depth = 0;
    let i = at + 'Alert.alert'.length;
    for (; i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')' && --depth === 0) break;
    }
    out.push({ call: source.slice(at, i + 1), line: source.slice(0, at).split('\n').length });
    at = source.indexOf('Alert.alert(', i);
  }
  return out;
}

function buttonCount(call: string): number {
  return (call.match(/\btext:/g) ?? []).length;
}

describe('alerts', () => {
  it('have at most three buttons, all of which Android shows', () => {
    const offenders = sourceFiles(SRC).flatMap((file) =>
      alertCalls(fs.readFileSync(file, 'utf8'))
        .filter(({ call }) => buttonCount(call) > 3)
        .map(({ line }) => `${path.relative(SRC, file)}:${line}`));
    expect(offenders).toEqual([]);
  });

  it('counts the buttons of a call', () => {
    const [call] = alertCalls("Alert.alert(name, undefined, [{ text: t('a', 'A'), onPress: () => f(1) }, { text: 'B' }]);");
    expect(buttonCount(call.call)).toBe(2);
  });
});

describe('the Files recent and starred menus', () => {
  const source = fs.readFileSync(path.join(SRC, 'screens/FilesScreen.tsx'), 'utf8');

  it('open a sheet with a Cancel row that Back and an outside tap close', () => {
    const body = source.slice(source.indexOf('function PlaceActionsSheet'), source.indexOf('interface FolderPickerSheetProps'));
    expect(body).toContain('onRequestClose={onClose}');
    expect(body).toContain('onPress={onClose}');
    expect(body).toContain("t('files.cancel', 'Cancel')");
    const recent = source.slice(source.indexOf('const recentActions'), source.indexOf('const starredActions'));
    expect(recent).toContain('setPlaceMenu(');
    expect(recent).not.toContain('Alert.alert');
  });
});
