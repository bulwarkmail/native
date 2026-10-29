// Which files open in the in-app preview, how, and how large they may be.
// One classification for every place that opens a file: the reader's and the
// list's attachment chips, the Files tab and compose. Port of the webmail's
// `lib/file-preview.ts`, narrowed to what each platform's viewers render;
// everything else goes to the OS "Open with" chooser.

export type PreviewKind =
  | 'image' | 'pdf' | 'text' | 'markdown' | 'html' | 'eml' | 'video' | 'audio' | 'archive' | 'none';

export interface FilePreviewOptions {
  /**
   * The platform's viewers decide what plays: video and audio play in the
   * system WebView (Chromium on Android, WebKit on iOS), whose formats
   * differ.
   */
  platform: 'ios' | 'android';
}

interface PreviewableFile {
  name: string;
  type?: string | null;
  size?: number | null;
}

/**
 * Largest file each preview kind loads. Text is rendered in one selectable
 * `<Text>`, which gets slow to lay out past a few hundred KB; HTML and
 * Markdown go through the mail sanitiser in JS; parsing an .eml and decoding
 * an image hold the whole file in memory, and so does listing a ZIP. PDFs
 * are paged by their viewer and media stream from the downloaded copy.
 * Larger files open in another app.
 */
export const FILE_PREVIEW_MAX_BYTES: Record<Exclude<PreviewKind, 'none'>, number> = {
  text: 512 * 1024,
  markdown: 1024 * 1024,
  html: 5 * 1024 * 1024,
  eml: 10 * 1024 * 1024,
  archive: 50 * 1024 * 1024,
  image: 25 * 1024 * 1024,
  pdf: 100 * 1024 * 1024,
  audio: 500 * 1024 * 1024,
  video: 1024 * 1024 * 1024,
};

function baseMime(type?: string | null): string {
  return (type || '').split(';')[0].trim().toLowerCase();
}

function extension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

// Generic types say nothing about the file; the name decides.
const GENERIC_MIME = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/unknown']);

// Images React Native's Image decodes, plus SVG and ICO, which the preview
// draws in a WebView. iOS decodes TIFF as well; Android's decoders don't.
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'jfif', 'pjpeg', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif', 'svg', 'ico']);
const IMAGE_MIME = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/gif', 'image/webp', 'image/bmp',
  'image/x-ms-bmp', 'image/heic', 'image/heif', 'image/avif', 'image/svg+xml', 'image/x-icon',
  'image/vnd.microsoft.icon', 'image/ico',
]);
const IOS_IMAGE_EXT = new Set(['tif', 'tiff']);
const IOS_IMAGE_MIME = new Set(['image/tiff', 'image/tif']);

// What the system WebView plays. Chromium handles the open formats and
// Matroska; WebKit handles Apple's, and neither plays AVI, WMV or FLV.
const MEDIA: Record<'video' | 'audio', Record<FilePreviewOptions['platform'], { ext: Set<string>; mime: Set<string> }>> = {
  video: {
    android: {
      ext: new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv', '3gp', '3g2']),
      mime: new Set(['video/mp4', 'video/x-m4v', 'video/quicktime', 'video/webm', 'video/ogg', 'video/x-matroska', 'video/3gpp', 'video/3gpp2']),
    },
    ios: {
      ext: new Set(['mp4', 'm4v', 'mov', '3gp', '3g2']),
      mime: new Set(['video/mp4', 'video/x-m4v', 'video/quicktime', 'video/3gpp', 'video/3gpp2']),
    },
  },
  audio: {
    android: {
      ext: new Set(['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'weba']),
      mime: new Set([
        'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/wave',
        'audio/ogg', 'audio/opus', 'audio/flac', 'audio/x-flac', 'audio/webm',
      ]),
    },
    ios: {
      ext: new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'aif', 'aiff', 'caf']),
      mime: new Set([
        'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/wave',
        'audio/flac', 'audio/x-flac', 'audio/aiff', 'audio/x-aiff', 'audio/x-caf',
      ]),
    },
  },
};

const ZIP_MIME = new Set(['application/zip', 'application/x-zip-compressed', 'application/x-zip']);
const HTML_MIME = new Set(['text/html', 'application/xhtml+xml']);
const HTML_EXT = new Set(['html', 'htm', 'xhtml', 'xht']);
const MARKDOWN_MIME = new Set(['text/markdown', 'text/x-markdown']);
const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdown', 'mkd', 'mkdn']);

// Plain text and source files, shown as text. Script types are inert there.
const TEXT_EXT = new Set([
  'txt', 'text', 'log', 'csv', 'tsv', 'json', 'xml', 'ics', 'vcf', 'yml', 'yaml', 'ini', 'conf', 'cfg', 'env',
  'properties', 'toml', 'diff', 'patch', 'sql', 'graphql', 'gql', 'css', 'scss', 'sass', 'less',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'pl', 'lua', 'r',
  'dart', 'scala', 'gradle', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'tex', 'rst', 'adoc', 'org', 'srt', 'vtt',
]);
const TEXT_FILE_NAMES = new Set(['dockerfile', 'makefile', 'readme', 'license', 'changelog', '.gitignore', '.editorconfig']);
const TEXT_MIME = new Set([
  'application/json', 'application/ld+json', 'application/xml', 'application/javascript',
  'application/x-javascript', 'application/typescript', 'application/x-sh', 'application/x-yaml',
  'application/yaml', 'application/toml', 'application/sql', 'application/graphql',
  'application/ics', 'application/icalendar',
]);

/** How the in-app preview renders a file, or 'none' for the OS chooser. */
export function filePreviewKind(file: Pick<PreviewableFile, 'name' | 'type'>, opts: FilePreviewOptions): PreviewKind {
  const declared = baseMime(file.type);
  const mime = GENERIC_MIME.has(declared) ? '' : declared;
  const name = file.name || '';
  const ext = extension(name);
  // An image, audio or video type decides the viewer. Any other type leaves
  // it to the name: senders put catch-alls such as the
  // application/x-as400attachment IBM i systems use on every part.
  const media = /^(image|audio|video)\//.test(mime);

  if (mime === 'message/rfc822' || ext === 'eml') return 'eml';
  // ZIPs list their files; formats built on ZIP (docx, apk) are not ZIPs here.
  if (ZIP_MIME.has(mime) || ((!mime || mime.startsWith('application/x-')) && ext === 'zip')) return 'archive';
  if (HTML_MIME.has(mime) || HTML_EXT.has(ext)) return 'html';
  if (MARKDOWN_MIME.has(mime) || MARKDOWN_EXT.has(ext)) return 'markdown';

  if (mime.startsWith('image/') || (!media && (IMAGE_EXT.has(ext) || IOS_IMAGE_EXT.has(ext)))) {
    // Compressed SVG needs a Content-Encoding a local file doesn't have.
    if (ext === 'svgz') return 'none';
    const ios = opts.platform === 'ios';
    const shown = IMAGE_MIME.has(mime) || IMAGE_EXT.has(ext)
      || (ios && (IOS_IMAGE_MIME.has(mime) || IOS_IMAGE_EXT.has(ext)));
    return shown ? 'image' : 'none';
  }
  // iOS's WebView shows PDFs; Android renders their pages (pdf-pages.ts).
  if (mime === 'application/pdf' || (!media && ext === 'pdf')) return 'pdf';
  for (const kind of ['video', 'audio'] as const) {
    const formats = MEDIA[kind][opts.platform];
    if (mime.startsWith(`${kind}/`)) return formats.mime.has(mime) || formats.ext.has(ext) ? kind : 'none';
    if (!media && formats.ext.has(ext)) return kind;
  }

  if (mime.startsWith('text/') || TEXT_MIME.has(mime) || /\+(json|xml)$/.test(mime)) return 'text';
  if (TEXT_EXT.has(ext) || TEXT_FILE_NAMES.has(name.toLowerCase())) return 'text';
  return 'none';
}

/** True when a known size is over the preview cap for `kind`. Unknown sizes pass; the caller checks the download. */
export function exceedsPreviewLimit(kind: PreviewKind, size: number | null | undefined): boolean {
  if (kind === 'none' || size == null) return false;
  return size > FILE_PREVIEW_MAX_BYTES[kind];
}

/**
 * The preview a tap on this file opens: its kind when the app can show it and
 * the file is within the cap, else 'none' (hand it to another app).
 */
export function inAppPreviewKind(file: PreviewableFile, opts: FilePreviewOptions): PreviewKind {
  const kind = filePreviewKind(file, opts);
  return exceedsPreviewLimit(kind, file.size) ? 'none' : kind;
}

/** Images Android's WebView can't decode, which the preview draws with React Native's Image instead. */
export function needsNativeImageDecoder(file: Pick<PreviewableFile, 'name' | 'type'>): boolean {
  const mime = baseMime(file.type);
  return /^image\/(heic|heif|tiff?)$/.test(mime) || /\.(heic|heif|tiff?)$/i.test(file.name);
}

/** Images React Native's Image can't draw, which go to the WebView viewer on iOS too. */
export function needsWebImageViewer(file: Pick<PreviewableFile, 'name' | 'type'>): boolean {
  const mime = baseMime(file.type);
  return /^image\/(svg\+xml|x-icon|vnd\.microsoft\.icon|ico)$/.test(mime) || /\.(svg|ico)$/i.test(file.name);
}

// Types for handing a file to another app when the sender declared none, or
// a catch-all: Android picks the apps for "Open with" by type, and finds
// none for application/octet-stream.
const EXT_TO_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  epub: 'application/epub+zip',
  zip: 'application/zip',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  apk: 'application/vnd.android.package-archive',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  md: 'text/markdown',
  json: 'application/json',
  xml: 'application/xml',
  ics: 'text/calendar',
  vcf: 'text/vcard',
  eml: 'message/rfc822',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  amr: 'audio/amr',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  '3gp': 'video/3gpp',
};

/**
 * The type to hand a file to another app with: the declared one, unless it
 * is generic or a catch-all that names no format, in which case the one the
 * file name implies.
 */
export function handoffMimeType(name: string | undefined, type: string | null | undefined): string {
  const declared = baseMime(type);
  const fromName = EXT_TO_MIME[extension(name || '')];
  if (!fromName) return type || 'application/octet-stream';
  if (GENERIC_MIME.has(declared)) return fromName;
  // An "x-" application type the name contradicts, such as x-as400attachment.
  if (/^application\/x-/.test(declared) && declared !== fromName) return fromName;
  return type || fromName;
}
