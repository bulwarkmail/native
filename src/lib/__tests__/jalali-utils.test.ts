import { describe, it, expect } from 'vitest';
import {
  JALALI_MONTHS,
  eachDayOfJalaliMonth,
  endOfJalaliMonth,
  isJalaliLeapYear,
  jalaliMonthLength,
  shouldUseJalaliCalendar,
  startOfJalaliMonth,
  toGregorian,
  toJalali,
} from '../jalali-utils';

// Values checked against jalaali-js 2.0.1. Webmail has no Jalali tests.

describe('Gregorian ↔ Jalali conversion', () => {
  it('converts Nowruz and the leap Esfand', () => {
    expect(toJalali(new Date(2024, 2, 20))).toEqual({ jy: 1403, jm: 1, jd: 1 });
    expect(toJalali(new Date(2025, 2, 20))).toEqual({ jy: 1403, jm: 12, jd: 30 });
    expect(toJalali(new Date(2025, 2, 21))).toEqual({ jy: 1404, jm: 1, jd: 1 });
    expect(isJalaliLeapYear(1403)).toBe(true);
    expect(isJalaliLeapYear(1404)).toBe(false);
    expect(jalaliMonthLength(1403, 12)).toBe(30);
    expect(jalaliMonthLength(1404, 12)).toBe(29);
  });

  it('gives back the Gregorian day at local midnight', () => {
    expect(toGregorian(1405, 7, 1)).toEqual(new Date(2026, 8, 23));
    expect(toGregorian(1404, 1, 1)).toEqual(new Date(2025, 2, 21));
  });

  it('round-trips every day of a year, leap Esfand included', () => {
    const start = new Date(2024, 2, 1);
    for (let i = 0; i < 400; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const { jy, jm, jd } = toJalali(d);
      expect(toGregorian(jy, jm, jd)).toEqual(d);
    }
  });

  it('names the twelve months, Farvardin to Esfand', () => {
    expect(JALALI_MONTHS).toHaveLength(12);
    expect(JALALI_MONTHS[0]).toBe('فروردین');
    expect(JALALI_MONTHS[6]).toBe('مهر');
    expect(JALALI_MONTHS[11]).toBe('اسفند');
  });
});

describe('Jalali month grid', () => {
  it('builds a whole-week grid for Mehr 1405 starting Saturday', () => {
    const days = eachDayOfJalaliMonth(1405, 7, 6);
    expect(days[0].getDay()).toBe(6);
    expect(days[days.length - 1].getDay()).toBe(5);
    expect(days.some((d) => +d === +new Date(2026, 8, 23))).toBe(true); // 1405/07/01
    expect(days.some((d) => +d === +new Date(2026, 9, 22))).toBe(true); // 1405/07/30
    expect(days.length % 7).toBe(0);
  });

  it('aligns the grid to the chosen first day of the week', () => {
    // 1 Mehr 1405 is a Wednesday; 30 Mehr a Thursday.
    expect(startOfJalaliMonth(1405, 7, 1)).toEqual(new Date(2026, 8, 21));
    expect(endOfJalaliMonth(1405, 7, 1)).toEqual(new Date(2026, 9, 25));
    expect(startOfJalaliMonth(1405, 7, 0)).toEqual(new Date(2026, 8, 20));
    expect(endOfJalaliMonth(1405, 7, 0)).toEqual(new Date(2026, 9, 24));
  });

  it('keeps every day at local midnight and one day apart', () => {
    const days = eachDayOfJalaliMonth(1403, 12, 6);
    for (let i = 1; i < days.length; i++) {
      expect(days[i].getHours()).toBe(0);
      const prev = days[i - 1];
      expect(days[i]).toEqual(new Date(prev.getFullYear(), prev.getMonth(), prev.getDate() + 1));
    }
  });
});

describe('shouldUseJalaliCalendar', () => {
  it('is on for Persian only', () => {
    expect(shouldUseJalaliCalendar('fa')).toBe(true);
    expect(shouldUseJalaliCalendar('ar')).toBe(false);
    expect(shouldUseJalaliCalendar('en')).toBe(false);
  });
});
