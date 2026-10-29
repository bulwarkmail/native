// Android's PDF pages for the file preview, rendered by BulwarkPdfModule
// (the platform's PdfRenderer) into PNGs next to the PDF. iOS needs none of
// this: its WebView shows PDFs itself.

import { NativeModules, Platform } from 'react-native';

export interface PdfPageSize {
  /** In points. */
  width: number;
  height: number;
}

interface NativePdf {
  open(fileUri: string): Promise<{ pages: PdfPageSize[] }>;
  renderPage(fileUri: string, index: number, width: number, outUri: string): Promise<string>;
  close(fileUri: string): Promise<void>;
}

function native(): NativePdf | null {
  if (Platform.OS !== 'android') return null;
  return (NativeModules.BulwarkPdf as NativePdf | undefined) ?? null;
}

/** Whether this build renders PDFs in-app. */
export function canRenderPdfPages(): boolean {
  return native() !== null;
}

export type PdfOpenFailure = 'protected' | 'unreadable';

export class PdfOpenError extends Error {
  constructor(readonly reason: PdfOpenFailure, message: string) {
    super(message);
  }
}

/** The pages of a PDF, or a {@link PdfOpenError} saying why it can't be shown. */
export async function openPdfPages(fileUri: string): Promise<PdfPageSize[]> {
  const pdf = native();
  if (!pdf) throw new PdfOpenError('unreadable', 'PDF rendering is not available');
  try {
    const { pages } = await pdf.open(fileUri);
    if (!pages.length) throw new PdfOpenError('unreadable', 'The PDF has no pages');
    return pages;
  } catch (e) {
    if (e instanceof PdfOpenError) throw e;
    const code = (e as { code?: string } | null)?.code;
    throw new PdfOpenError(code === 'E_PDF_PROTECTED' ? 'protected' : 'unreadable', e instanceof Error ? e.message : String(e));
  }
}

/** Render page `index` (0-based) `width` pixels wide into `outUri`. */
export function renderPdfPage(fileUri: string, index: number, width: number, outUri: string): Promise<string> {
  const pdf = native();
  if (!pdf) return Promise.reject(new Error('PDF rendering is not available'));
  return pdf.renderPage(fileUri, index, Math.round(width), outUri);
}

/** Let go of the open document. */
export function closePdfPages(fileUri: string): void {
  void native()?.close(fileUri).catch(() => undefined);
}

/** Name of the image a page is rendered into, next to the viewer page. */
export function pdfPageFileName(index: number): string {
  return `__page-${index + 1}.png`;
}
