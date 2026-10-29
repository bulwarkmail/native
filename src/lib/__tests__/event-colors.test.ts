import { describe, it, expect } from 'vitest';
import {
  DARK_EVENT_TEXT,
  eventBlockColors,
  inactiveEventTextColor,
  mixColors,
  parseColor,
  readableTextOn,
} from '../event-colors';

describe('parseColor', () => {
  it('reads the hex forms', () => {
    expect(parseColor('#abc')).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseColor('#3B82F6')).toEqual({ r: 59, g: 130, b: 246, a: 1 });
    expect(parseColor('#3b82f680')).toEqual({ r: 59, g: 130, b: 246, a: 128 / 255 });
    expect(parseColor('#abcd')?.a).toBeCloseTo(0xdd / 255);
    expect(parseColor('  #000000  ')).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  it('reads rgb() and rgba() in both syntaxes', () => {
    expect(parseColor('rgb(59, 130, 246)')).toEqual({ r: 59, g: 130, b: 246, a: 1 });
    expect(parseColor('rgba(59,130,246,0.5)')).toEqual({ r: 59, g: 130, b: 246, a: 0.5 });
    expect(parseColor('RGBA(128, 128, 128, .3)')).toEqual({ r: 128, g: 128, b: 128, a: 0.3 });
    expect(parseColor('rgb(59 130 246 / 50%)')).toEqual({ r: 59, g: 130, b: 246, a: 0.5 });
    expect(parseColor('rgb(100%, 0%, 0%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it('gives null for what it does not understand', () => {
    expect(parseColor('blue')).toBeNull();
    expect(parseColor('#12')).toBeNull();
    expect(parseColor('#12345')).toBeNull();
    expect(parseColor('rgb(1, 2)')).toBeNull();
    expect(parseColor('rgb(a, b, c)')).toBeNull();
    expect(parseColor('hsl(0, 100%, 50%)')).toBeNull();
    expect(parseColor('')).toBeNull();
    expect(parseColor(undefined)).toBeNull();
  });
});

describe('readableTextOn', () => {
  it('keeps white while white reaches 3:1 on the fill', () => {
    expect(readableTextOn('#3b82f6')).toBe('#ffffff'); // blue-500, 3.68:1
    expect(readableTextOn('#ef4444')).toBe('#ffffff'); // red-500, 3.76:1
    expect(readableTextOn('#000')).toBe('#ffffff');
    expect(readableTextOn('rgb(99, 102, 241)')).toBe('#ffffff');
  });

  it('switches to near-black on light fills', () => {
    expect(readableTextOn('#22c55e')).toBe(DARK_EVENT_TEXT); // green-500, 2.3:1
    expect(readableTextOn('#eab308')).toBe(DARK_EVENT_TEXT);
    expect(readableTextOn('#fbbf24')).toBe(DARK_EVENT_TEXT);
    expect(readableTextOn('#ffffff')).toBe(DARK_EVENT_TEXT);
  });

  it('does not depend on the theme', () => {
    // Same fill, same answer: nothing here reads the palette.
    expect(readableTextOn('#60a5fa')).toBe(readableTextOn('#60A5FA'));
  });

  it('falls back to white for colours it cannot read', () => {
    expect(readableTextOn('tomato')).toBe('#ffffff');
  });
});

describe('mixColors', () => {
  it('mixes like color-mix(in srgb)', () => {
    expect(mixColors('#ff0000', '#0000ff', 0.55)).toBe('#8c0073');
    expect(mixColors('#ffffff', '#000000', 0.5)).toBe('#808080');
    expect(mixColors('#123456', '#abcdef', 1)).toBe('#123456');
    expect(mixColors('#123456', '#abcdef', 0)).toBe('#abcdef');
  });

  it('interpolates alpha premultiplied', () => {
    expect(mixColors('rgba(255, 0, 0, 0.5)', '#0000ff', 0.5)).toBe('rgba(85, 0, 170, 0.75)');
    expect(mixColors('rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 0.5)).toBe('rgba(0, 0, 0, 0)');
  });

  it('gives null when a colour cannot be read', () => {
    expect(mixColors('blue', '#000000', 0.5)).toBeNull();
    expect(mixColors('#000000', 'nope', 0.5)).toBeNull();
  });
});

describe('inactiveEventTextColor', () => {
  it('is the calendar colour mixed 55% with the text colour', () => {
    // 0.55 × #3b82f6 + 0.45 × #0f172a
    expect(inactiveEventTextColor('#3b82f6', '#0f172a')).toBe('#27529a');
    // 0.55 × #3b82f6 + 0.45 × #fafafa
    expect(inactiveEventTextColor('#3b82f6', '#fafafa')).toBe('#91b8f8');
  });

  it('falls back to the text colour', () => {
    expect(inactiveEventTextColor('teal', '#0f172a')).toBe('#0f172a');
  });
});

describe('eventBlockColors', () => {
  const light = { background: '#ffffff', text: '#0f172a' };
  const dark = { background: '#09090b', text: '#fafafa' };

  it('paints active events solid with the computed label colour in either theme', () => {
    const expected = { fill: '#3b82f6', text: '#ffffff', border: null };
    expect(eventBlockColors('#3b82f6', false, light)).toEqual(expected);
    expect(eventBlockColors('#3b82f6', false, dark)).toEqual(expected);
    expect(eventBlockColors('#22c55e', false, dark).text).toBe(DARK_EVENT_TEXT);
  });

  it('puts declined and cancelled events on the page ground inside a calendar-coloured border', () => {
    expect(eventBlockColors('#3b82f6', true, light)).toEqual({
      fill: '#ffffff',
      text: '#27529a',
      border: '#3b82f6',
    });
    expect(eventBlockColors('#3b82f6', true, dark).fill).toBe('#09090b');
  });
});
