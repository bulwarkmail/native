import { describe, it, expect } from 'vitest';
import {
  filePreviewKind, inAppPreviewKind, exceedsPreviewLimit, FILE_PREVIEW_MAX_BYTES,
  needsNativeImageDecoder, needsWebImageViewer, handoffMimeType,
} from '../file-preview';

const IOS = { platform: 'ios' } as const;
const ANDROID = { platform: 'android' } as const;

describe('filePreviewKind', () => {
  it('previews common images by type or by extension', () => {
    expect(filePreviewKind({ name: 'photo.jpg', type: 'image/jpeg' }, ANDROID)).toBe('image');
    expect(filePreviewKind({ name: 'scan.PNG', type: 'application/octet-stream' }, ANDROID)).toBe('image');
    expect(filePreviewKind({ name: 'IMG_0001', type: 'image/heic' }, ANDROID)).toBe('image');
    expect(filePreviewKind({ name: 'anim.webp', type: '' }, ANDROID)).toBe('image');
  });

  it('draws SVG and ICO images instead of handing them off', () => {
    expect(filePreviewKind({ name: 'logo.svg', type: 'image/svg+xml' }, IOS)).toBe('image');
    expect(filePreviewKind({ name: 'logo.svg', type: 'application/octet-stream' }, ANDROID)).toBe('image');
    expect(filePreviewKind({ name: 'favicon.ico', type: 'image/x-icon' }, ANDROID)).toBe('image');
    expect(filePreviewKind({ name: 'logo.svgz', type: 'image/svg+xml' }, IOS)).toBe('none');
  });

  it('shows TIFF only where the platform decodes it', () => {
    expect(filePreviewKind({ name: 'fax.tiff', type: 'image/tiff' }, IOS)).toBe('image');
    expect(filePreviewKind({ name: 'fax.tif', type: '' }, IOS)).toBe('image');
    expect(filePreviewKind({ name: 'fax.tiff', type: 'image/tiff' }, ANDROID)).toBe('none');
    expect(filePreviewKind({ name: 'raw.cr2', type: 'image/x-canon-cr2' }, ANDROID)).toBe('none');
  });

  it('renders HTML and Markdown documents', () => {
    expect(filePreviewKind({ name: 'page.html', type: 'text/html' }, IOS)).toBe('html');
    expect(filePreviewKind({ name: 'page.htm', type: 'application/octet-stream' }, ANDROID)).toBe('html');
    expect(filePreviewKind({ name: 'doc', type: 'application/xhtml+xml' }, IOS)).toBe('html');
    expect(filePreviewKind({ name: 'README.md', type: 'application/octet-stream' }, ANDROID)).toBe('markdown');
    expect(filePreviewKind({ name: 'notes', type: 'text/markdown' }, ANDROID)).toBe('markdown');
  });

  it('shows PDFs in-app on both platforms', () => {
    expect(filePreviewKind({ name: 'report.pdf', type: 'application/pdf' }, IOS)).toBe('pdf');
    expect(filePreviewKind({ name: 'report.pdf', type: 'application/octet-stream' }, IOS)).toBe('pdf');
    expect(filePreviewKind({ name: 'report.pdf', type: 'application/pdf' }, ANDROID)).toBe('pdf');
    expect(filePreviewKind({ name: 'REPORT.PDF', type: '' }, ANDROID)).toBe('pdf');
  });

  it('plays the video formats each platform plays', () => {
    expect(filePreviewKind({ name: 'clip.mp4', type: 'video/mp4' }, IOS)).toBe('video');
    expect(filePreviewKind({ name: 'clip.mov', type: 'video/quicktime' }, IOS)).toBe('video');
    expect(filePreviewKind({ name: 'clip.mp4', type: 'video/mp4' }, ANDROID)).toBe('video');
    expect(filePreviewKind({ name: 'clip.webm', type: 'video/webm' }, ANDROID)).toBe('video');
    expect(filePreviewKind({ name: 'clip.mkv', type: 'application/octet-stream' }, ANDROID)).toBe('video');
    expect(filePreviewKind({ name: 'clip.webm', type: 'video/webm' }, IOS)).toBe('none');
    expect(filePreviewKind({ name: 'old.avi', type: 'video/x-msvideo' }, ANDROID)).toBe('none');
    expect(filePreviewKind({ name: 'old.wmv', type: 'video/x-ms-wmv' }, IOS)).toBe('none');
  });

  it('plays the audio formats each platform plays', () => {
    expect(filePreviewKind({ name: 'song.mp3', type: 'audio/mpeg' }, IOS)).toBe('audio');
    expect(filePreviewKind({ name: 'voice.m4a', type: '' }, IOS)).toBe('audio');
    expect(filePreviewKind({ name: 'memo.ogg', type: 'audio/ogg' }, ANDROID)).toBe('audio');
    expect(filePreviewKind({ name: 'memo.ogg', type: 'application/octet-stream' }, ANDROID)).toBe('audio');
    expect(filePreviewKind({ name: 'memo.opus', type: 'audio/ogg' }, IOS)).toBe('none');
    expect(filePreviewKind({ name: 'call.amr', type: 'audio/amr' }, ANDROID)).toBe('none');
  });

  it('shows plain text, data and source files as text', () => {
    expect(filePreviewKind({ name: 'notes.txt', type: 'text/plain' }, ANDROID)).toBe('text');
    expect(filePreviewKind({ name: 'data.csv', type: 'text/csv' }, ANDROID)).toBe('text');
    expect(filePreviewKind({ name: 'config', type: 'application/json' }, ANDROID)).toBe('text');
    expect(filePreviewKind({ name: 'feed', type: 'application/atom+xml' }, ANDROID)).toBe('text');
    expect(filePreviewKind({ name: 'app.ts', type: 'application/octet-stream' }, ANDROID)).toBe('text');
    expect(filePreviewKind({ name: 'main.py', type: '' }, ANDROID)).toBe('text');
    expect(filePreviewKind({ name: 'build.sh', type: 'application/x-sh' }, ANDROID)).toBe('text');
    expect(filePreviewKind({ name: 'index.js', type: 'text/javascript' }, ANDROID)).toBe('text');
    expect(filePreviewKind({ name: 'Dockerfile', type: '' }, ANDROID)).toBe('text');
    expect(filePreviewKind({ name: 'invite.ics', type: 'text/calendar' }, IOS)).toBe('text');
  });

  it('shows saved messages like the reader does', () => {
    expect(filePreviewKind({ name: 'bounce.eml', type: 'application/octet-stream' }, ANDROID)).toBe('eml');
    expect(filePreviewKind({ name: 'fwd', type: 'message/rfc822' }, ANDROID)).toBe('eml');
  });

  it('goes by the name when the declared type is a catch-all', () => {
    expect(filePreviewKind({ name: 'invoice.pdf', type: 'application/x-as400attachment' }, IOS)).toBe('pdf');
    expect(filePreviewKind({ name: 'photo.jpg', type: 'application/x-as400attachment' }, ANDROID)).toBe('image');
    expect(filePreviewKind({ name: 'download', type: 'image/png' }, ANDROID)).toBe('image');
  });

  it('lets a media type decide over the name', () => {
    expect(filePreviewKind({ name: 'clip.avi', type: 'video/mp4' }, ANDROID)).toBe('video');
    expect(filePreviewKind({ name: 'cover.mp3', type: 'image/jpeg' }, ANDROID)).toBe('image');
  });

  it('lists the files in a ZIP, but not in the formats built on ZIP', () => {
    expect(filePreviewKind({ name: 'archive.zip', type: 'application/zip' }, IOS)).toBe('archive');
    expect(filePreviewKind({ name: 'photos', type: 'application/x-zip-compressed' }, ANDROID)).toBe('archive');
    expect(filePreviewKind({ name: 'Archive.ZIP', type: 'application/octet-stream' }, ANDROID)).toBe('archive');
    expect(filePreviewKind({ name: 'app.apk', type: 'application/vnd.android.package-archive' }, ANDROID)).toBe('none');
  });

  it('leaves other archives, office documents and binaries to other apps', () => {
    expect(filePreviewKind({ name: 'backup.7z', type: 'application/x-7z-compressed' }, IOS)).toBe('none');
    expect(filePreviewKind({ name: 'logs.tar.gz', type: 'application/gzip' }, ANDROID)).toBe('none');
    expect(filePreviewKind({ name: 'sheet.xlsx', type: 'application/octet-stream' }, IOS)).toBe('none');
    expect(filePreviewKind({ name: 'contract.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, ANDROID)).toBe('none');
    expect(filePreviewKind({ name: 'data.bin', type: undefined }, IOS)).toBe('none');
  });

  it('ignores MIME parameters and case', () => {
    expect(filePreviewKind({ name: 'x', type: 'Text/Plain; charset=utf-8' }, ANDROID)).toBe('text');
    expect(filePreviewKind({ name: 'x', type: 'IMAGE/PNG' }, ANDROID)).toBe('image');
  });
});

describe('image viewer choice', () => {
  it('sends formats Chromium cannot decode to the native decoder', () => {
    expect(needsNativeImageDecoder({ name: 'IMG.HEIC', type: '' })).toBe(true);
    expect(needsNativeImageDecoder({ name: 'x', type: 'image/heif' })).toBe(true);
    expect(needsNativeImageDecoder({ name: 'photo.jpg', type: 'image/jpeg' })).toBe(false);
  });

  it('sends formats React Native cannot draw to the WebView', () => {
    expect(needsWebImageViewer({ name: 'logo.svg', type: '' })).toBe(true);
    expect(needsWebImageViewer({ name: 'x', type: 'image/x-icon' })).toBe(true);
    expect(needsWebImageViewer({ name: 'photo.jpg', type: 'image/jpeg' })).toBe(false);
  });
});

describe('preview size limits', () => {
  it('caps text far below images, PDFs and media', () => {
    expect(FILE_PREVIEW_MAX_BYTES.text).toBe(512 * 1024);
    expect(FILE_PREVIEW_MAX_BYTES.text).toBeLessThan(FILE_PREVIEW_MAX_BYTES.image);
    expect(FILE_PREVIEW_MAX_BYTES.image).toBeLessThan(FILE_PREVIEW_MAX_BYTES.pdf);
    expect(FILE_PREVIEW_MAX_BYTES.pdf).toBeLessThan(FILE_PREVIEW_MAX_BYTES.video);
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
    expect(inAppPreviewKind({ name: 'film.mp4', type: 'video/mp4', size: 300 * 1024 * 1024 }, ANDROID)).toBe('video');
  });
});

describe('handoffMimeType', () => {
  it('keeps a real declared type', () => {
    expect(handoffMimeType('a.pdf', 'application/pdf')).toBe('application/pdf');
    expect(handoffMimeType('scan', 'image/png')).toBe('image/png');
    expect(handoffMimeType('a.zip', 'application/x-zip-compressed')).toBe('application/zip');
  });

  it('names the format when the declared type does not, so Android finds a viewer', () => {
    expect(handoffMimeType('contract.docx', 'application/octet-stream'))
      .toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(handoffMimeType('invoice.PDF', '')).toBe('application/pdf');
    expect(handoffMimeType('invoice.pdf', 'application/x-as400attachment')).toBe('application/pdf');
    expect(handoffMimeType('photo.jpg', 'application/x-unknown')).toBe('image/jpeg');
  });

  it('falls back to the declared type or octet-stream for unknown names', () => {
    expect(handoffMimeType('data.bin', '')).toBe('application/octet-stream');
    expect(handoffMimeType('data.xyz', 'application/x-foo')).toBe('application/x-foo');
  });
});
