import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { allowedMailboxPresets } from '../delegation/share-presets';

// Folder sharing offers only the roles the organisation allows (webmail
// share-collection-dialog.tsx, policy restriction `sharingRights`).

describe('allowedMailboxPresets', () => {
  it('offers every role without a limit, or with write allowed', () => {
    expect(allowedMailboxPresets(null)).toEqual(['read', 'readWrite', 'manager']);
    expect(allowedMailboxPresets(undefined)).toEqual(['read', 'readWrite', 'manager']);
    expect(allowedMailboxPresets(['read', 'write'])).toEqual(['read', 'readWrite', 'manager']);
  });

  it('offers Read only when the admin allows read alone (or nothing it knows)', () => {
    expect(allowedMailboxPresets(['read'])).toEqual(['read']);
    expect(allowedMailboxPresets(['bogus'])).toEqual(['read']);
  });

  it('is what the folder share sheet offers', () => {
    const source = readFileSync(join(__dirname, '../../components/sharing/MailboxShareSheet.tsx'), 'utf8');
    expect(source).toContain('allowedMailboxPresets(allowedValues)');
    expect(source).toMatch(/\]\.filter\(\(preset\) => allowed\.includes\(preset\.key\)\)/);
  });
});
