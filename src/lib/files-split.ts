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

/** Room the folder name keeps beside the Files header buttons before it moves to a line of its own. */
export const FILES_TITLE_MIN = 120;
const HEADER_PADDING = 12; // spacing.md, each side
const HEADER_BUTTON = 44; // componentSizes.buttonLg
const HEADER_GAP = 4; // spacing.xs, between buttons
const HEADER_ROW_GAP = 8; // spacing.sm, title side to buttons

/**
 * Width left for the folder name in the Files header, `width` wide, with
 * `buttons` buttons on the right and a back button or not. Next to the docked
 * preview (280 to 420 dp) the four or five buttons left a folder name about
 * 50 dp: "…".
 */
export function filesHeaderTitleRoom(width: number, buttons: number, back: boolean): number {
  const actions = buttons * HEADER_BUTTON + Math.max(0, buttons - 1) * HEADER_GAP;
  const left = back ? HEADER_BUTTON + HEADER_GAP : 0;
  return width - 2 * HEADER_PADDING - actions - HEADER_ROW_GAP - left;
}

/** Whether the folder name goes on its own line under the header buttons. A width not measured yet keeps it beside them. */
export function filesTitleOnOwnRow(width: number, buttons: number, back: boolean): boolean {
  return width > 0 && filesHeaderTitleRoom(width, buttons, back) < FILES_TITLE_MIN;
}
