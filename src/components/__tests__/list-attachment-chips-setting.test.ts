import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The attachment chips under list rows couldn't be turned off (webmail
// "Show attachments in the list", c136bd816, #1604). Off, the list neither
// draws the chips nor loads the rows' parts; the paperclip stays.

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '../..', p), 'utf8');

describe('Show attachments in the list', () => {
  it('is on by default, as in the webmail', () => {
    expect(read('stores/settings-store.ts')).toMatch(/showVerificationCodes: true,\r?\n\s*showAttachmentChips: true,/);
  });

  it('is a switch in the reading settings', () => {
    const src = read('components/settings/ReadingSettings.tsx');
    expect(src).toMatch(/settings\.email_behavior\.show_attachment_chips\.label/);
    expect(src).toMatch(/<ToggleSwitch checked=\{showAttachmentChips\} onChange=\{\(v\) => update\('showAttachmentChips', v\)\} \/>/);
  });

  it('gives the rows neither the chips nor their loader while off', () => {
    const src = read('screens/EmailListScreen.tsx');
    expect(src).toMatch(/loadAttachments=\{showAttachmentChips \? loadAttachments : undefined\}/);
    expect(src).toMatch(/onOpenAttachment=\{showAttachmentChips \? openAttachment : undefined\}/);
    // The row draws the chips only with an opener, and loads parts only with it.
    expect(src).toMatch(/useListAttachments\(item, onOpenAttachment \? loadAttachments : undefined\)/);
    expect(src).toMatch(/\{onOpenAttachment && \(\r?\n\s*<ListAttachmentChips/);
  });
});
