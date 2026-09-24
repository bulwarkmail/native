import { describe, it, expect } from 'vitest';
import {
  filePreviewKind, inAppPreviewKind, exceedsPreviewLimit, FILE_PREVIEW_MAX_BYTES,
} from '../file-preview';

const IOS = { inlinePdf: true };
const ANDROID = { inlinePdf: false };

describe('filePreviewKind', () => {
  it('previews the images React Native decodes, by type or by extension', () => {
    expect(filePreviewKind({ name: 'photo.jpg', type: 'image/jpeg' }, ANDROID)).toBe('image');
    expect(filePreviewKind({ name: 'scan.PNG', type: 'application/octet-stream' }, ANDROID)).toBe('image');
    expect(filePreviewKind({ name: 'IMG_0001', type: 'image/heic' }, ANDROID)).toBe('image');
    expect(filePreviewKind({ name: 'anim.webp', type: '' }, ANDROID)).toBe('image');
  });

  it('hands images it cannot decode to another app', () => {
    expect(filePreviewKind({ name: 'fax.tiff', type: 'image/tiff' }, ANDROID)).toBe('none');
    expect(filePreviewKind({ name: 'raw.cr2', type: 'image/x-canon-cr2' }, ANDROID)).toBe('none');
  });

  it('keeps script-bearing documents out of the preview', () => {
    expect(filePreviewKind({ name: 'logo.svg', type: 'image/svg+xml' }, IOS)).toBe('none');
    expect(filePreviewKind({ name: 'page.html', type: 'text/html' }, IOS)).toBe('none');
    expect(filePreviewKind({ name: 'page.htm', type: 'application/octet-stream' }, IOS)).toBe('none');
    expect(filePreviewKind({ name: 'doc', type: 'application/xhtml+xml' }, IOS)).toBe('none');
  });

  it('shows PDFs in-app only where the platform renders them', () => {
    expect(filePreviewKind({ name: 'report.pdf', type: 'application/pdf' }, IOS)).toBe('pdf');
    expect(filePreviewKind({ name: 'report.pdf', type: 'application/octet-stream' }, IOS)).toBe('pdf');
    expect(filePreviewKind({ name: 'report.pdf', type: 'application/pdf' }, ANDROID)).toBe('none');
  });

  it('shows plain text, markdown and data files as text', () => {
    expect(filePreviewKind({ name: 'notes.txt', type: 'text/plain' }, ANDROID)).toBe('text');
    expect(filePreviewKind({ name: 'README.md', type: 'application/octet-stream' }, ANDROID)).toBe('text');
    expect(filePreviewKind({ name: 'data.csv', type: 'text/csv' }, ANDROID)).toBe('text');
    expect(filePreviewKind({ name: 'config', type: 'application/json' }, ANDROID)).toBe('text');
    expect(filePreviewKind({ name: 'feed', type: 'application/atom+xml' }, ANDROID)).toBe('text');
  });

  it('shows source code as text, including the script types the reader leaves out', () => {
    expect(filePreviewKind({ name: 'app.ts', type: 'application/octet-stream' }, ANDROID)).toBe('text');
    expect(filePreviewKind({ name: 'main.py', type: '' }, ANDROID)).toBe('text');
    expect(filePreviewKind({ name: 'build.sh', type: 'application/x-sh' }, ANDROID)).toBe('text');
    expect(filePreviewKind({ name: 'index.js', type: 'text/javascript' }, ANDROID)).toBe('text');
    expect(filePreviewKind({ name: 'bundle', type: 'application/javascript' }, ANDROID)).toBe('text');
    expect(filePreviewKind({ name: 'Dockerfile', type: '' }, ANDROID)).toBe('text');
  });

  it('shows saved messages like the reader does', () => {
    expect(filePreviewKind({ name: 'bounce.eml', type: 'application/octet-stream' }, ANDROID)).toBe('eml');
    expect(filePreviewKind({ name: 'fwd', type: 'message/rfc822' }, ANDROID)).toBe('eml');
  });

  it('leaves binaries and office documents to other apps', () => {
    expect(filePreviewKind({ name: 'archive.zip', type: 'application/zip' }, IOS)).toBe('none');
    expect(filePreviewKind({ name: 'sheet.xlsx', type: 'application/octet-stream' }, IOS)).toBe('none');
    expect(filePreviewKind({ name: 'movie.mp4', type: 'video/mp4' }, IOS)).toBe('none');
    expect(filePreviewKind({ name: 'data.bin', type: undefined }, IOS)).toBe('none');
  });

  it('ignores MIME parameters and case', () => {
    expect(filePreviewKind({ name: 'x', type: 'Text/Plain; charset=utf-8' }, ANDROID)).toBe('text');
    expect(filePreviewKind({ name: 'x', type: 'IMAGE/PNG' }, ANDROID)).toBe('image');
  });
});

describe('preview size limits', () => {
  it('caps text far below images and PDFs', () => {
    expect(FILE_PREVIEW_MAX_BYTES.text).toBe(512 * 1024);
    expect(FILE_PREVIEW_MAX_BYTES.text).toBeLessThan(FILE_PREVIEW_MAX_BYTES.image);
    expect(FILE_PREVIEW_MAX_BYTES.image).toBeLessThan(FILE_PREVIEW_MAX_BYTES.pdf);
  });

  it('flags only known sizes over the cap', () => {
    expect(exceedsPreviewLimit('text', FILE_PREVIEW_MAX_BYTES.text)).toBe(false);
    expect(exceedsPreviewLimit('text', FILE_PREVIEW_MAX_BYTES.text + 1)).toBe(true);
    expect(exceedsPreviewLimit('text', undefined)).toBe(false);
    expect(exceedsPreviewLimit('text', null)).toBe(false);
    expect(exceedsPreviewLimit('none', 10 ** 12)).toBe(false);
  });

  it('opens files over the cap in another app instead', () => {
    const big = { name: 'server.log', type: 'text/plain', size: 5 * 1024 * 1024 };
    expect(inAppPreviewKind(big, ANDROID)).toBe('none');
    expect(inAppPreviewKind({ ...big, size: 20 * 1024 }, ANDROID)).toBe('text');
    expect(inAppPreviewKind({ ...big, size: undefined }, ANDROID)).toBe('text');
    expect(inAppPreviewKind({ name: 'pano.jpg', type: 'image/jpeg', size: 40 * 1024 * 1024 }, ANDROID)).toBe('none');
    expect(inAppPreviewKind({ name: 'pano.jpg', type: 'image/jpeg', size: 4 * 1024 * 1024 }, ANDROID)).toBe('image');
  });
});
