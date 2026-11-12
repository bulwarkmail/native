import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { renameAttachmentProblem, splitAttachmentName } from '../attachment-display';

// An attachment couldn't be renamed when saving a copy (webmail
// rename-attachment-dialog.tsx, lib/attachment-name.ts, fc54c1915, #1623).

describe('Save as… for an attachment', () => {
  it('keeps the extension apart so the copy keeps its type', () => {
    expect(splitAttachmentName('report.pdf')).toEqual(['report', '.pdf']);
    expect(splitAttachmentName('archive.tar.gz')).toEqual(['archive.tar', '.gz']);
    expect(splitAttachmentName('README')).toEqual(['README', '']);
    expect(splitAttachmentName('.bashrc')).toEqual(['.bashrc', '']);
    expect(splitAttachmentName('name.')).toEqual(['name.', '']);
  });

  it('refuses slashes, control characters and too long a name', () => {
    expect(renameAttachmentProblem('Invoice March')).toBeNull();
    expect(renameAttachmentProblem('a/b')).toBe('chars');
    expect(renameAttachmentProblem('a\\b')).toBe('chars');
    expect(renameAttachmentProblem(`a${String.fromCharCode(7)}b`)).toBe('chars');
    expect(renameAttachmentProblem('x'.repeat(256))).toBe('tooLong');
  });

  it('is offered in the attachment sheet and saves under the typed name, without the template', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../components/email/AttachmentChips.tsx'), 'utf8');
    expect(src).toMatch(/key: 'save_as',/);
    expect(src).toMatch(/downloadAttachment\(item\.att\.blobId, name, item\.att\.type, null, jmapAccountId\)/);
    expect(src).toMatch(/<RenameAttachmentPrompt\r?\n\s*name=\{renaming\?\.name \?\? null\}/);
    const prompt = fs.readFileSync(path.resolve(__dirname, '../../components/email/RenameAttachmentPrompt.tsx'), 'utf8');
    expect(prompt).toMatch(/onSubmit\(value\.trim\(\) \+ ext\);/);
  });
});
