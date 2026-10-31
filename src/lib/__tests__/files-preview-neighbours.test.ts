import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { previewNeighbours } from '../files-preview-neighbours';

// The Files preview had no way to the folder's next file (file 10 "next/
// previous in preview"); the webmail's ←/→ step through the folder's other
// previewable files.

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');

describe('previous / next in the Files preview', () => {
  const files = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('finds the neighbours of the open file', () => {
    expect(previewNeighbours(files, { id: 'b' })).toEqual({ previous: { id: 'a' }, next: { id: 'c' } });
    expect(previewNeighbours(files, { id: 'a' })).toEqual({ previous: undefined, next: { id: 'b' } });
    expect(previewNeighbours(files, { id: 'c' })).toEqual({ previous: { id: 'b' }, next: undefined });
    expect(previewNeighbours(files, { id: 'gone' })).toEqual({});
    expect(previewNeighbours(files, null)).toEqual({});
  });

  // No RN renderer in the test env: check the wiring instead.
  it('puts the buttons in the preview header, fed from the listed files it can show', () => {
    const modal = read('../../components/email/AttachmentPreviewModal.tsx');
    expect(modal).toMatch(/<Text style=\{styles\.title\}[^\n]*<\/Text>\s*\{headerActions\}/);
    const preview = read('../../components/files/FilePreviewModal.tsx');
    expect(preview).toMatch(/accessibilityLabel=\{t\('files\.previous_file', 'Previous file'\)\}/);
    expect(preview).toMatch(/accessibilityLabel=\{t\('files\.next_file', 'Next file'\)\}/);
    expect(preview).toMatch(/headerActions=\{headerActions\}/);
    const screen = read('../../screens/FilesScreen.tsx');
    expect(screen).toMatch(/visibleFiles\.filter\(\(r\) => !isFolder\(r\) && !isSymlink\(r\) && canPreviewInApp\(r\)\)/);
    expect(screen.match(/onPrevious=\{showPrevious\}/g)).toHaveLength(2);
    expect(screen.match(/onNext=\{showNext\}/g)).toHaveLength(2);
  });
});
