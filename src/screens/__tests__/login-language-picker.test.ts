import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// A language choice before sign-in (webmail 32dc8b7ef): every sign-in step's
// header has the language button, and it sets the app's language setting,
// which the sign-in keeps.

const read = (...parts: string[]) => readFileSync(join(__dirname, '..', ...parts), 'utf8');

describe('the sign-in language picker', () => {
  it('sits in the header of every sign-in step', () => {
    const shell = read('login', 'LoginShell.tsx');
    expect(shell).toMatch(/import \{ LoginLanguagePicker \} from '\.\/LoginLanguagePicker';/);
    expect(shell).toMatch(/<View style=\{styles\.headerEnd\}>[\s\S]*?<LoginLanguagePicker \/>/);
  });

  it("sets the app's language, or back to the phone's", () => {
    const picker = read('login', 'LoginLanguagePicker.tsx');
    expect(picker).toMatch(/const setOverride = useLocaleStore\(\(s\) => s\.setOverride\);/);
    expect(picker).toMatch(/onPress=\{\(\) => choose\(code === 'system' \? null : code\)\}/);
    expect(picker).toMatch(/SUPPORTED_LOCALES\.map\(\(l\) => row\(l\.code, l\.label\)\)/);
  });
});
