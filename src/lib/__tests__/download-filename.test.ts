import { describe, it, expect } from 'vitest';
import {
  emailExportFilename,
  attachmentDownloadFilename,
  buildSampleEmail,
  DEFAULT_EMAIL_TEMPLATE,
} from '../download-filename';

const SAMPLE = buildSampleEmail();

describe('emailExportFilename', () => {
  it('renders the default template and appends .eml', () => {
    const name = emailExportFilename(SAMPLE, DEFAULT_EMAIL_TEMPLATE);
    expect(name.endsWith('.eml')).toBe(true);
    expect(name).toContain('2026-05-22');
    expect(name).toContain('Alice');
    expect(name).toContain('Bob');
  });

  it('falls back to "email.eml" when the template renders empty', () => {
    expect(emailExportFilename(SAMPLE, '')).toBe('email.eml');
  });

  it('applies the lowercase + underscore transforms', () => {
    const name = emailExportFilename(SAMPLE, {
      template: '{from} {subject}',
      lowercase: true,
      spaceReplacement: 'underscore',
    });
    expect(name).toBe(name.toLowerCase());
    expect(name).not.toContain(' ');
  });

  it('strips diacritics when requested', () => {
    const name = emailExportFilename(SAMPLE, {
      template: '{subject}',
      stripDiacritics: true,
    });
    // "Gerät" → "Gerat"
    expect(name).toContain('Gerat');
    expect(name).not.toContain('ä');
  });
});

describe('attachmentDownloadFilename', () => {
  const attachment = { name: 'Rechnung 2026.pdf', type: 'application/pdf' };

  it('keeps the original name with the {filename} template', () => {
    const name = attachmentDownloadFilename(SAMPLE, attachment, '{filename}');
    expect(name).toBe('Rechnung 2026.pdf');
  });

  it('re-appends the extension when the template omits it', () => {
    const name = attachmentDownloadFilename(SAMPLE, attachment, '{date_short} {name}');
    expect(name.endsWith('.pdf')).toBe(true);
    expect(name).toContain('2026-05-22');
  });

  it('falls back to the raw name when no email is provided', () => {
    const name = attachmentDownloadFilename(null, attachment);
    expect(name).toBe('Rechnung 2026.pdf');
  });
});
