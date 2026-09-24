import { describe, it, expect } from 'vitest';
import { filesBackStep } from '../files-back';

describe('filesBackStep', () => {
  it('leaves the tab only at the root with nothing open', () => {
    expect(filesBackStep({ previewOpen: false, selecting: false, folderDepth: 0 })).toBe('leave');
  });

  it('goes up one folder inside a subfolder', () => {
    expect(filesBackStep({ previewOpen: false, selecting: false, folderDepth: 1 })).toBe('folder-up');
    expect(filesBackStep({ previewOpen: false, selecting: false, folderDepth: 3 })).toBe('folder-up');
  });

  it('ends selection mode before changing folders', () => {
    expect(filesBackStep({ previewOpen: false, selecting: true, folderDepth: 2 })).toBe('clear-selection');
    expect(filesBackStep({ previewOpen: false, selecting: true, folderDepth: 0 })).toBe('clear-selection');
  });

  it('closes an open preview before anything else', () => {
    expect(filesBackStep({ previewOpen: true, selecting: true, folderDepth: 2 })).toBe('close-preview');
    expect(filesBackStep({ previewOpen: true, selecting: false, folderDepth: 0 })).toBe('close-preview');
  });
});
