// Which Files-tab nodes open in the in-app preview, and how large they may be.
// Builds on the reader's attachment classification (`previewKindFor`) so both
// previews agree, and adds what a drive holds more often than mail: source
// code and config files, shown as text. Port of the webmail's
// `lib/file-preview.ts`, narrowed to what the native preview can render;
// everything else keeps going to the OS "Open with" chooser.

import { previewKindFor, type PreviewKind } from './attachment-display';

export interface FilePreviewOptions {
  /**
   * Whether this platform renders PDFs in-app. iOS does, in the WebView;
   * Android has no built-in renderer, so a PDF there goes straight to the
   * PDF viewer instead of a preview screen that can only offer that viewer.
   */
  inlinePdf: boolean;
}

interface PreviewableFile {
  name: string;
  type?: string | null;
  size?: number | null;
}

/**
 * Largest file each preview kind loads. Text is rendered in one selectable
 * `<Text>`, which gets slow to lay out past a few hundred KB; parsing an
 * .eml and decoding an image hold the whole file in memory; PDFs are paged by
 * the WebView. Larger files open in another app instead.
 */
export const FILE_PREVIEW_MAX_BYTES: Record<Exclude<PreviewKind, 'none'>, number> = {
  text: 512 * 1024,
  eml: 10 * 1024 * 1024,
  image: 25 * 1024 * 1024,
  pdf: 50 * 1024 * 1024,
};

// Script-bearing documents open in the browser, as in the reader. The webmail
// renders HTML in a sandboxed iframe and SVG through <img>; neither has a safe
// native equivalent here.
const NEVER_INLINE_MIME = new Set(['text/html', 'application/xhtml+xml', 'image/svg+xml']);
const NEVER_INLINE_EXT = /\.(html?|xht(ml)?|svgz?)$/i;

// Formats React Native's Image decodes. Other image types (TIFF, RAW, PSD,
// ICO) would render blank.
const RENDERABLE_IMAGE_MIME = new Set([
  'image/png', 'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/gif', 'image/webp',
  'image/bmp', 'image/x-ms-bmp', 'image/heic', 'image/heif', 'image/avif',
]);
const RENDERABLE_IMAGE_EXT = /\.(png|jpe?g|jfif|gif|webp|bmp|heic|heif|avif)$/i;

// Source and config files the reader's list doesn't cover (it only sees mail
// attachments). The webmail's TEXT_EXTENSIONS plus the languages the Files
// tab already draws a code icon for.
const CODE_EXT = new RegExp(
  '\\.('
  + 'text|tsv|toml|cfg|env|properties|sql|graphql|gql|css|scss|sass|less'
  + '|js|mjs|cjs|jsx|ts|mts|cts|tsx|vue|svelte'
  + '|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|pl|lua|r|dart|scala|gradle'
  + '|sh|bash|zsh|fish|ps1|bat|cmd'
  + '|tex|rst|adoc|org|srt|vtt'
  + ')$',
  'i',
);
const CODE_FILE_NAMES = new Set(['dockerfile', 'makefile', 'readme', 'license', 'changelog', '.gitignore', '.editorconfig']);
const TEXT_MIME = new Set([
  'application/json', 'application/ld+json', 'application/xml', 'application/javascript',
  'application/x-javascript', 'text/javascript', 'application/typescript', 'application/x-sh',
  'application/x-yaml', 'application/yaml', 'application/toml', 'application/sql', 'application/graphql',
]);

function baseMime(type?: string | null): string {
  return (type || '').split(';')[0].trim().toLowerCase();
}

/** How the in-app preview renders a file, or 'none' for the OS chooser. */
export function filePreviewKind(file: Pick<PreviewableFile, 'name' | 'type'>, opts: FilePreviewOptions): PreviewKind {
  const mime = baseMime(file.type);
  const name = file.name || '';
  if (NEVER_INLINE_MIME.has(mime) || NEVER_INLINE_EXT.test(name)) return 'none';
  const kind = previewKindFor({ name, type: mime });
  switch (kind) {
    case 'image':
      return RENDERABLE_IMAGE_MIME.has(mime) || RENDERABLE_IMAGE_EXT.test(name) ? 'image' : 'none';
    case 'pdf':
      return opts.inlinePdf ? 'pdf' : 'none';
    case 'none':
      // The reader keeps .js and friends out; shown as source text they are inert.
      if (CODE_EXT.test(name) || CODE_FILE_NAMES.has(name.toLowerCase())) return 'text';
      if (TEXT_MIME.has(mime) || /\+(json|xml)$/.test(mime)) return 'text';
      return 'none';
    default:
      return kind;
  }
}

/** True when a known size is over the preview cap for `kind`. Unknown sizes pass; the caller checks the download. */
export function exceedsPreviewLimit(kind: PreviewKind, size: number | null | undefined): boolean {
  if (kind === 'none' || size == null) return false;
  return size > FILE_PREVIEW_MAX_BYTES[kind];
}

/**
 * The preview a tap on this file opens: its kind when the app can show it and
 * the file is within the cap, else 'none' (hand it to another app, as before).
 */
export function inAppPreviewKind(file: PreviewableFile, opts: FilePreviewOptions): PreviewKind {
  const kind = filePreviewKind(file, opts);
  return exceedsPreviewLimit(kind, file.size) ? 'none' : kind;
}
