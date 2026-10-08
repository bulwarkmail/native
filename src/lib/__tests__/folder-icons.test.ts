import { describe, it, expect } from 'vitest';
import { FOLDER_ICON_NAMES, isFolderIconName, folderIconLabel } from '../folder-icons';

describe('folder icons', () => {
  it('offers webmail\'s 18 icons in its order', () => {
    expect(FOLDER_ICON_NAMES).toHaveLength(18);
    expect(FOLDER_ICON_NAMES).toEqual([
      'Folder', 'Star', 'Heart', 'Bookmark', 'Tag', 'Flag', 'Briefcase', 'Users', 'Bell',
      'Zap', 'Globe', 'Lock', 'Eye', 'MessageSquare', 'Mail', 'Inbox', 'Archive', 'FileText',
    ]);
  });

  it('recognises only those names', () => {
    expect(isFolderIconName('Heart')).toBe(true);
    expect(isFolderIconName('heart')).toBe(false);
    expect(isFolderIconName('Trash2')).toBe(false);
    expect(isFolderIconName('toString')).toBe(false);
    expect(isFolderIconName(3)).toBe(false);
    expect(isFolderIconName(null)).toBe(false);
  });

  it('reads camel-case names as words for screen readers', () => {
    expect(folderIconLabel('MessageSquare')).toBe('Message square');
    expect(folderIconLabel('FileText')).toBe('File text');
    expect(folderIconLabel('Heart')).toBe('Heart');
  });
});
