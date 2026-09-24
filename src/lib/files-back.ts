/** What Android back does in the Files tab. */
export type FilesBackStep = 'close-preview' | 'clear-selection' | 'folder-up' | 'leave';

/**
 * Back works through the tab's own layers, innermost first: an open preview
 * closes, then selection mode ends (like the header's X), then the folder
 * goes up one level. Only at the root with nothing open does it `leave`,
 * i.e. fall through to navigation, which switches to the Mail tab.
 */
export function filesBackStep(state: {
  previewOpen: boolean;
  selecting: boolean;
  folderDepth: number;
}): FilesBackStep {
  if (state.previewOpen) return 'close-preview';
  if (state.selecting) return 'clear-selection';
  if (state.folderDepth > 0) return 'folder-up';
  return 'leave';
}
