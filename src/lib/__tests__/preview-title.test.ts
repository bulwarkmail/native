import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { previewTitle } from '../preview-title';

// Webmail 4f00deffe: an attached message without a file name of its own is
// called by its subject, not "attachment" or "Email.eml".
describe('the title of a previewed file', () => {
  it('names an unnamed attached message by its subject', () => {
    expect(previewTitle({ kind: 'eml', name: 'attachment', eml: { subject: 'Invoice 42' } })).toBe('Invoice 42');
    expect(previewTitle({ kind: 'eml', name: 'Email.eml', eml: { subject: ' Re: Plans ' } })).toBe('Re: Plans');
  });

  it('keeps a real file name, and the made-up one when there is no subject', () => {
    expect(previewTitle({ kind: 'eml', name: 'march-report.eml', eml: { subject: 'Report' } })).toBe('march-report.eml');
    expect(previewTitle({ kind: 'eml', name: 'attachment', eml: {} })).toBe('attachment');
    expect(previewTitle({ kind: 'pdf', name: 'attachment' })).toBe('attachment');
  });

  // No render setup in the repo: the header is checked for using it.
  it('is what the preview header shows', () => {
    const modal = readFileSync(join(__dirname, '../../components/email/AttachmentPreviewModal.tsx'), 'utf-8');
    expect(modal).toMatch(/numberOfLines=\{1\}>\{item \? previewTitle\(item\) : title \?\? ''\}<\/Text>/);
  });
});
