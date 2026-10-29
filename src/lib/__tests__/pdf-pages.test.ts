import { afterEach, describe, expect, it, vi } from 'vitest';
import { NativeModules } from 'react-native';
import { openPdfPages, PdfOpenError, renderPdfPage, canRenderPdfPages } from '../pdf-pages';

const modules = NativeModules as Record<string, unknown>;

function nativeError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('pdf-pages', () => {
  afterEach(() => { delete modules.BulwarkPdf; });

  it('reports the page sizes the renderer returns', async () => {
    modules.BulwarkPdf = { open: vi.fn(async () => ({ pages: [{ width: 595, height: 842 }] })) };
    await expect(openPdfPages('file:///x.pdf')).resolves.toEqual([{ width: 595, height: 842 }]);
  });

  it('tells a password-protected PDF from an unreadable one', async () => {
    modules.BulwarkPdf = { open: vi.fn(async () => { throw nativeError('E_PDF_PROTECTED', 'password'); }) };
    await expect(openPdfPages('file:///x.pdf')).rejects.toMatchObject({ reason: 'protected' });

    modules.BulwarkPdf = { open: vi.fn(async () => { throw nativeError('E_PDF_OPEN', 'not a PDF'); }) };
    await expect(openPdfPages('file:///x.pdf')).rejects.toMatchObject({ reason: 'unreadable' });

    modules.BulwarkPdf = { open: vi.fn(async () => ({ pages: [] })) };
    await expect(openPdfPages('file:///x.pdf')).rejects.toBeInstanceOf(PdfOpenError);
  });

  it('fails cleanly in a build without the renderer', async () => {
    expect(canRenderPdfPages()).toBe(false);
    await expect(openPdfPages('file:///x.pdf')).rejects.toMatchObject({ reason: 'unreadable' });
    await expect(renderPdfPage('file:///x.pdf', 0, 100, 'file:///p.png')).rejects.toThrow();
  });

  it('renders at a whole pixel width', async () => {
    const renderPage = vi.fn(async () => 'file:///p.png');
    modules.BulwarkPdf = { renderPage };
    await renderPdfPage('file:///x.pdf', 2, 1620.6, 'file:///p.png');
    expect(renderPage).toHaveBeenCalledWith('file:///x.pdf', 2, 1621, 'file:///p.png');
  });
});
