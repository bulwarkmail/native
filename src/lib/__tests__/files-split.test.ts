import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('react-native', () => ({ useWindowDimensions: () => ({ width: 800, height: 1280 }) }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

import {
  FILES_LIST_MIN, FILES_TITLE_MIN, PREVIEW_HEADER_CHROME, PREVIEW_TITLE_MIN,
  filesHeaderTitleRoom, filesListWidth, filesTitleOnOwnRow,
} from '../files-split';

// In the tablet split view the docked file preview had a fixed 45 % of the
// row. On a Pixel Tablet in portrait (about 720 dp next to the tab rail)
// that left the header's file name 2 px between its six buttons.
const titleRoom = (contentWidth: number) => contentWidth - filesListWidth(contentWidth) - PREVIEW_HEADER_CHROME;

describe('filesListWidth', () => {
  it('leaves the file name room in the preview header on a tablet in portrait', () => {
    expect(titleRoom(720)).toBeGreaterThanOrEqual(PREVIEW_TITLE_MIN);
    expect(filesListWidth(720)).toBeGreaterThanOrEqual(FILES_LIST_MIN);
  });

  it('gives the list its usual pane width on a wide window', () => {
    expect(filesListWidth(1200)).toBe(408);
    expect(titleRoom(1200)).toBeGreaterThan(400);
  });

  it('keeps the list usable on a narrow split', () => {
    expect(filesListWidth(600)).toBe(FILES_LIST_MIN);
  });
});

describe('the folder name in the Files header next to the docked preview', () => {
  it('had about 50 dp beside four buttons and Back in a 320 dp list column', () => {
    expect(filesHeaderTitleRoom(320, 4, true)).toBe(52);
    expect(filesHeaderTitleRoom(320, 5, false)).toBe(52);
  });

  it('moves under the buttons when that is too little, and stays beside them when there is room', () => {
    expect(filesTitleOnOwnRow(filesListWidth(720), 4, true)).toBe(true);
    expect(filesTitleOnOwnRow(FILES_LIST_MIN, 5, false)).toBe(true);
    expect(filesTitleOnOwnRow(800, 4, true)).toBe(false);
    expect(filesHeaderTitleRoom(800, 4, true)).toBeGreaterThanOrEqual(FILES_TITLE_MIN);
    // Not measured yet: beside the buttons, as before.
    expect(filesTitleOnOwnRow(0, 5, true)).toBe(false);
  });

  it('is how the header lays out its title', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../screens/FilesScreen.tsx'), 'utf8');
    expect(source).toMatch(/const titleOwnRow = isSplit && previewTarget != null && filesTitleOnOwnRow\(headerWidth, headerButtons, canBack\);/);
    expect(source).toMatch(/onLayout=\{\(e\) => setHeaderWidth\(e\.nativeEvent\.layout\.width\)\}/);
    expect(source).toMatch(/\{titleOwnRow \? \(\s*<Text style=\{styles\.title\} numberOfLines=\{2\}>/);
  });
});

describe('the Files split view', () => {
  it('sizes the list column with filesListWidth and lets the preview take the rest', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../screens/FilesScreen.tsx'), 'utf8');
    expect(source).toContain('width: filesListWidth(contentWidth)');
    expect(source).not.toMatch(/previewPane: \{[^}]*width: '45%'/);
  });
});
