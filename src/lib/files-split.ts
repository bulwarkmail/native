import { listPaneWidth } from './use-layout';

/**
 * Fixed chrome of the docked file preview's header: 16 dp padding on each
 * side and six 40 dp buttons (close, previous, next, open, download, share)
 * with 8 dp gaps, the title's gap included.
 */
export const PREVIEW_HEADER_CHROME = 2 * 16 + 6 * 40 + 6 * 8;
/** Room the file name keeps in the docked preview's header. */
export const PREVIEW_TITLE_MIN = 120;
/** The file list never gets narrower than this next to a preview. */
export const FILES_LIST_MIN = 280;

/**
 * Width of the file list next to the docked preview. The preview had a fixed
 * 45 %: on a tablet in portrait (about 720 dp next to the tab rail) that was
 * 324 dp, and the six header buttons left the file name 2 px. The list takes
 * the usual list-pane width (listPaneWidth, as in Mail and Contacts) and
 * gives way, down to FILES_LIST_MIN, until the name has PREVIEW_TITLE_MIN.
 */
export function filesListWidth(contentWidth: number): number {
  const previewMin = PREVIEW_HEADER_CHROME + PREVIEW_TITLE_MIN;
  return Math.max(FILES_LIST_MIN, Math.min(listPaneWidth(contentWidth), contentWidth - previewMin));
}
