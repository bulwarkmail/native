// The type a file is handed to another app with is never an installable type
// that the name the user saw contradicts: the name decides, as it does for the
// chip and the preview.
import { describe, it, expect } from 'vitest';
import { filePreviewKind, handoffMimeType } from '../file-preview';

const APK = 'application/vnd.android.package-archive';

describe('hand-off type of an attachment', () => {
  it('does not give "invoice.pdf" to the package installer', () => {
    // The chip and the preview both say PDF ...
    expect(filePreviewKind({ name: 'invoice.pdf', type: APK }, { platform: 'android' })).toBe('pdf');
    // ... so "Open in app" must not carry the APK type.
    expect(handoffMimeType('invoice.pdf', APK)).not.toBe(APK);
  });

  it.each([
    ['photo.jpg', APK],
    ['report.docx', APK],
    ['notes.txt', APK],
    ['holiday.png', 'application/vnd.android.package-archive; x=1'],
    ['invoice.pdf', 'APPLICATION/VND.ANDROID.PACKAGE-ARCHIVE'],
    ['INVOICE.PDF', APK],
    ['app.apk.pdf', APK],
    // No extension, or one the app doesn't know: a generic type, not the installer.
    ['invoice', APK],
    ['invoice.xyz', APK],
    ['invoice.apk.', APK],
  ])('%s declared as %s is not handed over as a package', (name, type) => {
    expect(handoffMimeType(name, type).toLowerCase()).not.toContain('android.package-archive');
  });

  it('still hands a real .apk over as a package', () => {
    expect(handoffMimeType('app-release.apk', APK)).toBe(APK);
    expect(handoffMimeType('app-release.apk', 'application/octet-stream')).toBe(APK);
    expect(handoffMimeType('invoice.pdf.apk', 'application/pdf')).toBe(APK);
    expect(handoffMimeType('APP.APK', '')).toBe(APK);
  });

  it('keeps the declared type where the name agrees or says nothing', () => {
    expect(handoffMimeType('invoice.pdf', 'application/pdf')).toBe('application/pdf');
    expect(handoffMimeType('data', 'application/x-as400attachment')).toBe('application/x-as400attachment');
    expect(handoffMimeType('scan.pdf', 'application/x-as400attachment')).toBe('application/pdf');
  });

  it('goes by the name when the declared type is another known one', () => {
    expect(handoffMimeType('photo.jpg', 'application/pdf')).toBe('image/jpeg');
    expect(handoffMimeType('report.pdf', 'text/html')).toBe('application/pdf');
  });
});
