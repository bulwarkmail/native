import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// At 200% text size the reader's header and toolbar stayed at 100% while
// the list and the body grew: their styles were built from the fixed
// tokens. They now take the user's text size from useTypography, as the
// list does. No React Native renderer in the test env, so this checks the
// wiring.

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

const FILES = {
  'screens/EmailThreadScreen.tsx': 6,
  'components/email/MessageHeader.tsx': 1,
  'components/email/ThreadMessageCard.tsx': 2,
};

describe('reader text size', () => {
  for (const [file, uses] of Object.entries(FILES)) {
    it(`builds the styles of ${file} at the user's text size`, () => {
      const src = read(file);
      expect(src).toMatch(/function makeStyles\(c: ThemePalette, typography: ScaledTypography = tokenTypography\)/);
      expect(src).not.toMatch(/makeStyles\(c\)/);
      expect((src.match(/const scaledType = useTypography\(\);\s+const styles = React\.useMemo\(\(\) => makeStyles\(c, scaledType\), \[c, scaledType\]\);/g) ?? []).length)
        .toBe(uses);
    });
  }

  it('scales the subject line with the text size', () => {
    const src = read('screens/EmailThreadScreen.tsx');
    const subject = src.slice(src.indexOf('  subjectText: {'), src.indexOf('  subjectText: {') + 300);
    expect(subject).toMatch(/fontSize: typography\.h3\.fontSize,/);
    expect(subject).not.toMatch(/fontSize: 18,/);
  });
});
