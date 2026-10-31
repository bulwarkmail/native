import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { unknownPersonLabel } from '../unknown-person';
import { principalRowDisplay } from '../../../lib/delegation/display';

// Settings > Sharing said "Unknown person", the folder share sheet "Unknown user".

const t = (_key: string, fallback?: string) => fallback ?? '';
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', '..', rel), 'utf8');

describe('a sharee without a name', () => {
  it('reads like Settings > Sharing', () => {
    expect(unknownPersonLabel(t)).toBe('Unknown person');
    expect(unknownPersonLabel((key) => key)).toBe(principalRowDisplay(null, (key) => key).name);
  });

  it('is what the folder, calendar, address book and file share sheets show', () => {
    for (const file of ['components/sharing/ShareCollectionSheet.tsx', 'components/files/ShareSheet.tsx']) {
      const src = read(file);
      expect(src, file).not.toMatch(/sharing\.unknown_user|Unknown user/);
      expect(src, file).toMatch(/unresolved \? unknownPersonLabel\(t\) : principalId/);
    }
  });
});
