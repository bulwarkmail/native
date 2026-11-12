import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isPhishingMarked, turnOffLinks } from '../phishing-links';
import { bodyDocument } from '../email-body-document';

// A message reported as phishing on the webmail ($phishing) opened on the
// phone with live links and no warning (webmail lib/phishing-links.ts,
// 50f95f446).

const TEXT = { title: 'link turned off', note: '(link turned off)' };

describe('turnOffLinks', () => {
  it('takes the address off every link and area and says the link is off', () => {
    const html = '<p>Hi <a href="https://evil.example/login" target="_blank" rel="noopener" style="color:red">sign in</a>'
      + '<map><area shape="rect" href="https://evil.example/x" alt="x"></map></p>';
    const out = turnOffLinks(html, TEXT);
    expect(out).not.toMatch(/href=/);
    expect(out).not.toMatch(/target=|rel=/);
    expect(out).toMatch(/<a data-link-off aria-disabled="true" title="link turned off" style="color:red;color:inherit !important;/);
    expect(out).toMatch(/sign in<span data-link-off-note style="[^"]*"> \(link turned off\)<\/span><\/a>/);
    expect(out).toMatch(/<area shape="rect" alt="x" data-link-off aria-disabled="true" title="link turned off">/);
    expect(out).toMatch(/^<p>Hi /);
  });

  it('turns off the links of a whole body document, plain text included, and leaves the rest as it is', () => {
    const common = {
      key: 'k', emptyLabel: '', blockRemoteImages: true, cidMap: {}, isDark: false,
      messageSpacing: 'auto' as const, plainTextFont: 'mono' as const, quoteLabels: { show: 's', hide: 'h' },
    };
    const html = bodyDocument({ ...common, key: 'h', rawHtml: '<a href="https://evil.example/a">Pay</a><style>a{color:red}</style>', text: null }).html;
    const plain = bodyDocument({ ...common, key: 'p', rawHtml: null, text: 'Go to https://evil.example/b now' }).html;
    for (const doc of [html, plain]) {
      expect(doc).toMatch(/evil\.example/);
      const out = turnOffLinks(doc, TEXT);
      expect(out).not.toMatch(/href="https:\/\/evil/);
      expect(out).toMatch(/data-link-off/);
      // Only the link tags change.
      expect(out.replace(/<a [^>]*>|<span data-link-off-note[^>]*>[^<]*<\/span>/g, '')).toBe(doc.replace(/<a [^>]*>/g, ''));
    }
  });

  it('leaves a body without links untouched', () => {
    const doc = '<!DOCTYPE html><html><head><style>p{}</style></head><body><p>no links</p></body></html>';
    expect(turnOffLinks(doc, TEXT)).toBe(doc);
  });

  it("doesn't read a link inside a style sheet or a comment", () => {
    const doc = '<style>/* <a href="x"> */</style><!-- <a href="y"> --><a href="z">z</a>';
    expect(turnOffLinks(doc, TEXT)).toBe(
      '<style>/* <a href="x"> */</style><!-- <a href="y"> --><a data-link-off aria-disabled="true" title="link turned off" style="color:inherit !important;text-decoration:underline dotted !important;cursor:not-allowed !important">z<span data-link-off-note style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap"> (link turned off)</span></a>',
    );
  });
});

describe('isPhishingMarked', () => {
  it('reads $phishing', () => {
    expect(isPhishingMarked({ keywords: { $phishing: true } })).toBe(true);
    expect(isPhishingMarked({ keywords: { $junk: true } })).toBe(false);
    expect(isPhishingMarked(null)).toBe(false);
  });
});

describe('reader', () => {
  it('turns links off, refuses link taps and shows the banner for a $phishing message', () => {
    const body = fs.readFileSync(path.resolve(__dirname, '..', '..', 'components/EmailBodyView.tsx'), 'utf8');
    expect(body).toMatch(/const phishingMarked = isPhishingMarked\(email\);/);
    expect(body).toMatch(/html: phishingMarked \? turnOffLinks\(html, linksOff\) : html/);
    expect(body).toMatch(/if \(phishingMarked\) return false;\r?\n\s*if \(\/\^mailto:\/i\.test\(url\)\)/);
    expect(body).toMatch(/\{phishingMarked && \(\r?\n\s*<View style=\{styles\.phishingBanner\}/);
    expect(body).toMatch(/phishing_report\.banner/);
  });
});
