import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { cleanPreview, stripEmphasisMarkers, stripLeadingCss } from '../preview-text';

// Copied from the webmail (lib/__tests__/preview-leading-css.test.ts), plus
// the check that the list rows use it (#1136).

// Some servers build a message preview from its HTML without skipping the
// <style> element, so a marketing mail's preview starts with its style sheet.
describe('stripLeadingCss', () => {
  it('drops a leading media query and keeps the text after it', () => {
    const preview = '@media screen and (min-width:600px){.hide{display:none!important;overflow:hidden!important}.show{display:block!important}} Your parcel is on its way';
    expect(stripLeadingCss(preview)).toBe('Your parcel is on its way');
  });

  it('drops several leading rules in a row', () => {
    expect(stripLeadingCss('.a{color:red} #b p{margin:0} td, th {padding:0}Hello')).toBe('Hello');
  });

  it('drops a leading @import that ends without a block', () => {
    expect(stripLeadingCss("@import url('x.css'); Weekly digest")).toBe('Weekly digest');
  });

  it('empties a preview that ends inside the style sheet', () => {
    expect(stripLeadingCss('@media screen and (min-width:600px){.hide{display:none!important;max-height:0!import')).toBe('');
  });

  it('leaves ordinary text alone, braces and all', () => {
    for (const text of [
      'Hi Luca, the meeting is at {time} tomorrow',
      '#1234 has been shipped',
      '@Luca can you check the figures?',
      'Order {A-17} confirmed',
      'Price {EUR}: 10 per box',
      'Meeting at {room',
      '@media team, the brief is attached',
      '@Page can you check?',
      '@import the CSV, then send it back',
      'Reminder: your appointment {date: 2026-10-01} is confirmed',
    ]) expect(stripLeadingCss(text)).toBe(text);
  });
});

describe('cleanPreview', () => {
  it('strips padding and a style sheet together, and treats nothing left as no preview', () => {
    expect(cleanPreview('\u034f \u200b.x{color:red} Real text')).toBe('Real text');
    expect(cleanPreview('.x{color:red} ...')).toBe('');
    expect(cleanPreview(null)).toBe('');
  });
});

// The preview comes from the text/plain part, which marks bold with asterisks
// where the HTML part uses <strong> (#1260).
describe('stripEmphasisMarkers', () => {
  it('drops emphasis markers around words', () => {
    expect(cleanPreview('*@Claude* mentioned you: please review')).toBe('@Claude mentioned you: please review');
    expect(stripEmphasisMarkers('This is **really** important.')).toBe('This is really important.');
    expect(stripEmphasisMarkers('See _the docs_ and __this__, (*now*)')).toBe('See the docs and this, (now)');
  });

  it('leaves asterisks and underscores inside words or between spaces alone', () => {
    for (const text of [
      '2 * 3 * 4 = 24',
      'a*b*c and snake_case_name',
      'rating: * * *',
      'my_var_ is set',
      'footnote* and *',
      '***',
      '__init__.py changed',
    ]) expect(stripEmphasisMarkers(text)).toBe(text);
  });
});

describe('stripLeadingCss pseudo-classes', () => {
  it('still drops a rule whose selector has a pseudo-class', () => {
    expect(stripLeadingCss('a:hover, a:focus{color:red} Hello')).toBe('Hello');
  });
});

describe('list rows', () => {
  it('show the cleaned preview', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '../..', p), 'utf8');
    expect(read('screens/EmailListScreen.tsx')).toMatch(/singleLine\(cleanPreview\(item\.preview\)\)/);
    expect(read('screens/UnifiedInboxScreen.tsx')).toMatch(/singleLine\(cleanPreview\(item\.preview\)\)/);
    expect(read('components/email/ThreadMessageCard.tsx')).toMatch(/singleLine\(cleanPreview\(email\.preview\)\)/);
  });
});
