import { describe, expect, it } from 'vitest';
import { cleanPreview, previewLine } from '../preview-text';
import { buildRowLabel } from '../list-row-label';

describe('previewLine', () => {
  it('skips a leading media query and keeps the prose', () => {
    expect(previewLine('@media screen and (min-width:600px){.hide{display:none!important}} Hello there')).toBe('Hello there');
  });
  it('skips a selector rule and @import', () => {
    expect(previewLine('@import url(x.css); body{margin:0} .a{color:red}\n\nWelcome\nback')).toBe('Welcome back');
  });
  it('returns empty when the preview is only a truncated style sheet', () => {
    expect(previewLine('@media screen{.a{color:red')).toBe('');
  });
  it('keeps prose with braces and mentions', () => {
    expect(previewLine('Reminder: your appointment {date: tomorrow}')).toBe('Reminder: your appointment {date: tomorrow}');
    expect(previewLine('@Page 3 of the notes')).toBe('@Page 3 of the notes');
  });
  it('drops invisible padding and a bare ellipsis', () => {
    expect(cleanPreview('​͏  Hi')).toBe('Hi');
    expect(cleanPreview('...')).toBe('');
    expect(previewLine(null)).toBe('');
  });
  it('is linear on 200 KB hostile input', () => {
    const inputs = [
      '@media{'.repeat(30000),
      '.a{b:c}'.repeat(30000),
      'a'.repeat(200_000),
      '{'.repeat(200_000),
      `a${' '.repeat(200_000)}b`,
      '͏'.repeat(200_000) + 'x',
    ];
    for (const input of inputs) {
      const start = Date.now();
      previewLine(input);
      expect(Date.now() - start).toBeLessThan(1000);
    }
  });
});

describe('buildRowLabel', () => {
  it('joins unread, sender, subject, time, attachment and flagged', () => {
    expect(buildRowLabel({
      sender: 'Ann', subject: 'Lunch', time: '10:00', unread: 'Unread', attachment: 'Has attachment', flagged: 'Starred',
    })).toBe('Unread, Ann, Lunch, 10:00, Has attachment, Starred');
  });
  it('leaves out states that do not apply', () => {
    expect(buildRowLabel({ sender: 'Ann', subject: 'Lunch', time: '10:00' })).toBe('Ann, Lunch, 10:00');
  });
});
