import { describe, expect, it } from "vitest";
import {
  FULL_DAY_HOURS,
  displayGridHeight,
  eventRect,
  initialScrollY,
  minutesAtY,
  minutesToY,
  rangeChangeScrollY,
  revealScrollY,
  isValidWorkingDays,
  isValidHourPair,
  clipToDisplayHours,
  formatDisplayHour,
  indexOfDayOnOrAfter,
  partitionByDisplayHours,
  remapSegmentsToShownDays,
  resolveDisplayHours,
  resolveWorkingDays,
} from "../calendar-display-range";
import type { CalendarWeekSegment } from "../calendar-utils";
import type { CalendarEvent } from "../../api/types";
import { hourAtOffset } from "../calendar-time-grid";

function timed(id: string, start: string, duration: string): CalendarEvent {
  return {
    id, "@type": "Event", uid: id, title: id, start, duration,
    showWithoutTime: false, calendarIds: { cal: true },
  } as unknown as CalendarEvent;
}

const WORK_HOURS = resolveDisplayHours(true, 8, 20);

describe("resolveDisplayHours (#1164)", () => {
  it("restricts the grid to the configured hours", () => {
    expect(WORK_HOURS).toEqual({ startMinutes: 480, endMinutes: 1200, restricted: true });
  });

  it("shows the whole day when switched off or set to the whole day", () => {
    expect(resolveDisplayHours(false, 8, 20)).toBe(FULL_DAY_HOURS);
    expect(resolveDisplayHours(true, 0, 24)).toBe(FULL_DAY_HOURS);
  });

  it.each([
    [20, 8], [8, 8], [-1, 20], [8, 25], [8.5, 20], ["8", 20], [null, undefined],
  ])("falls back to the whole day for a malformed range %s-%s", (start, end) => {
    expect(resolveDisplayHours(true, start, end)).toBe(FULL_DAY_HOURS);
  });
});

describe("resolveWorkingDays (#1164)", () => {
  it("returns the selected weekdays", () => {
    expect(resolveWorkingDays(true, [1, 2, 3, 4, 5])).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it("shows every day when off, empty, complete or malformed", () => {
    expect(resolveWorkingDays(false, [1, 2])).toBeNull();
    expect(resolveWorkingDays(true, [])).toBeNull();
    expect(resolveWorkingDays(true, [0, 1, 2, 3, 4, 5, 6])).toBeNull();
    expect(resolveWorkingDays(true, "1,2")).toBeNull();
    expect(resolveWorkingDays(true, [7, -1, 1.5])).toBeNull();
  });

  it("ignores entries that are not weekdays", () => {
    expect(resolveWorkingDays(true, [1, 9, "2", 3])).toEqual(new Set([1, 3]));
  });
});

describe("partitionByDisplayHours (#1164)", () => {
  const day = new Date(2026, 8, 9);

  it("counts events above and below the visible hours instead of drawing them", () => {
    const result = partitionByDisplayHours([
      timed("early", "2026-09-09T06:00:00", "PT1H"),
      timed("ends-at-start", "2026-09-09T07:00:00", "PT1H"),
      timed("straddles-start", "2026-09-09T07:30:00", "PT1H"),
      timed("zero-at-start", "2026-09-09T08:00:00", "PT0M"),
      timed("ends-at-end", "2026-09-09T19:30:00", "PT30M"),
      timed("late", "2026-09-09T21:00:00", "PT1H"),
      timed("starts-at-end", "2026-09-09T20:00:00", "PT30M"),
    ], day, WORK_HOURS);

    expect(result.visible.map((e) => e.id)).toEqual(["straddles-start", "zero-at-start", "ends-at-end"]);
    expect(result.before).toBe(2);
    expect(result.firstBeforeMinutes).toBe(360);
    expect(result.after).toBe(2);
    expect(result.firstAfterMinutes).toBe(1200);
  });

  it("keeps every event when the whole day is shown", () => {
    const events = [timed("early", "2026-09-09T06:00:00", "PT1H")];
    const result = partitionByDisplayHours(events, day, FULL_DAY_HOURS);
    expect(result.visible).toBe(events);
    expect(result.before).toBe(0);
  });

  it("keeps an event spanning the visible hours from the previous night", () => {
    const result = partitionByDisplayHours([timed("overnight", "2026-09-08T22:00:00", "PT12H")], day, WORK_HOURS);
    expect(result.visible).toHaveLength(1);
  });
});

describe("clipToDisplayHours (#1164)", () => {
  it("cuts an event to the visible hours and reports which ends were cut", () => {
    expect(clipToDisplayHours(420, 540, WORK_HOURS)).toEqual({
      startMinutes: 480, endMinutes: 540, clippedStart: true, clippedEnd: false,
    });
    expect(clipToDisplayHours(1140, 1260, WORK_HOURS)).toEqual({
      startMinutes: 1140, endMinutes: 1200, clippedStart: false, clippedEnd: true,
    });
  });

  it("leaves a whole-day grid untouched", () => {
    expect(clipToDisplayHours(0, 1440, FULL_DAY_HOURS)).toEqual({
      startMinutes: 0, endMinutes: 1440, clippedStart: false, clippedEnd: false,
    });
  });
});

describe("remapSegmentsToShownDays (#1164)", () => {
  // Mon 7 .. Sun 20 Sep 2026 with weekends hidden: columns Mon-Fri, Mon-Fri.
  const shown = [0, 1, 2, 3, 4, -1, -1, 5, 6, 7, 8, 9, -1, -1];
  const segment = (startIndex: number, span: number): CalendarWeekSegment => ({
    event: timed("e", "2026-09-07T00:00:00", "P1D"),
    startIndex, span, row: 0, continuesBefore: false, continuesAfter: false,
  });

  it("moves a segment across a hidden weekend onto the shown columns", () => {
    // Fri 11 .. Mon 14 -> Fri column 4 .. Mon column 5
    expect(remapSegmentsToShownDays([segment(4, 4)], shown)).toEqual([
      expect.objectContaining({ startIndex: 4, span: 2, row: -1, continuesBefore: false, continuesAfter: false }),
    ]);
  });

  it("drops a segment that only covers hidden days", () => {
    expect(remapSegmentsToShownDays([segment(5, 2)], shown)).toEqual([]);
  });

  it("marks a segment as continuing where hidden days were cut off", () => {
    // Sat 12 .. Tue 15 -> Mon .. Tue, continuing before
    expect(remapSegmentsToShownDays([segment(5, 4)], shown)).toEqual([
      expect.objectContaining({ startIndex: 5, span: 2, continuesBefore: true, continuesAfter: false }),
    ]);
    // Thu 17 .. Sun 20 -> Thu .. Fri, continuing after
    expect(remapSegmentsToShownDays([segment(10, 4)], shown)).toEqual([
      expect.objectContaining({ startIndex: 8, span: 2, continuesBefore: false, continuesAfter: true }),
    ]);
  });
});

describe("indexOfDayOnOrAfter", () => {
  const days = [new Date(2026, 8, 11), new Date(2026, 8, 14), new Date(2026, 8, 15)];

  it("finds the next shown day for a hidden one", () => {
    expect(indexOfDayOnOrAfter(days, new Date(2026, 8, 12, 15, 30))).toBe(1);
    expect(indexOfDayOnOrAfter(days, new Date(2026, 8, 14))).toBe(1);
  });

  it("clamps to the loaded days", () => {
    expect(indexOfDayOnOrAfter(days, new Date(2026, 8, 1))).toBe(0);
    expect(indexOfDayOnOrAfter(days, new Date(2026, 9, 1))).toBe(2);
  });
});

describe("formatDisplayHour", () => {
  it("labels the end of the day as 24:00", () => {
    expect(formatDisplayHour(8, "24h")).toBe("08:00");
    expect(formatDisplayHour(24, "24h")).toBe("24:00");
    expect(formatDisplayHour(24, "12h")).toBe("12:00 AM");
    expect(formatDisplayHour(20, "12h")).toBe("8:00 PM");
  });
});

const HOUR_HEIGHT = 48;
const legacyY = (minutes: number) => (minutes / 60) * HOUR_HEIGHT;

describe("minutesToY with the full day (limiting off)", () => {
  it("the full day is unchanged when limiting is off", () => {
    const off = resolveDisplayHours(false, 8, 20);
    expect(displayGridHeight(off, HOUR_HEIGHT)).toBe(24 * HOUR_HEIGHT);
    for (let m = 0; m <= 1440; m++) {
      expect(minutesToY(m, off, HOUR_HEIGHT)).toBe(legacyY(m));
    }
  });

  it("gives every event today's top and height", () => {
    for (const [start, end] of [[0, 30], [90, 100], [600, 735], [1380, 1440], [0, 1440]]) {
      const rect = eventRect(start, end, FULL_DAY_HOURS, HOUR_HEIGHT);
      expect(rect.top).toBe(legacyY(start));
      expect(rect.height).toBe(Math.max(20, ((end - start) / 60) * HOUR_HEIGHT - 1));
    }
  });

  it("keeps today's hour for a long press and today's scroll to now", () => {
    expect(hourAtOffset(48 * 13 + 5, HOUR_HEIGHT, FULL_DAY_HOURS)).toBe(13);
    expect(hourAtOffset(48 * 30, HOUR_HEIGHT, FULL_DAY_HOURS)).toBe(23);
    expect(hourAtOffset(-4, HOUR_HEIGHT, FULL_DAY_HOURS)).toBe(0);
    for (let h = 0; h < 24; h++) {
      expect(initialScrollY(h * 60 + 30, FULL_DAY_HOURS, HOUR_HEIGHT)).toBe(Math.max(0, (h - 1) * HOUR_HEIGHT));
    }
  });
});

describe("minutesToY with working hours", () => {
  it("measures from the first visible hour", () => {
    expect(minutesToY(480, WORK_HOURS, HOUR_HEIGHT)).toBe(0);
    expect(minutesToY(540, WORK_HOURS, HOUR_HEIGHT)).toBe(HOUR_HEIGHT);
    expect(displayGridHeight(WORK_HOURS, HOUR_HEIGHT)).toBe(12 * HOUR_HEIGHT);
  });

  it("round-trips through minutesAtY inside the range", () => {
    for (let m = WORK_HOURS.startMinutes; m <= WORK_HOURS.endMinutes; m += 5) {
      expect(minutesAtY(minutesToY(m, WORK_HOURS, HOUR_HEIGHT), WORK_HOURS, HOUR_HEIGHT)).toBeCloseTo(m, 9);
    }
  });

  it("turns a long press into the hour at that y", () => {
    expect(hourAtOffset(0, HOUR_HEIGHT, WORK_HOURS)).toBe(8);
    expect(hourAtOffset(HOUR_HEIGHT * 2 + 5, HOUR_HEIGHT, WORK_HOURS)).toBe(10);
    expect(hourAtOffset(HOUR_HEIGHT * 12 - 1, HOUR_HEIGHT, WORK_HOURS)).toBe(19);
    expect(hourAtOffset(HOUR_HEIGHT * 40, HOUR_HEIGHT, WORK_HOURS)).toBe(19);
    expect(hourAtOffset(-10, HOUR_HEIGHT, WORK_HOURS)).toBe(8);
  });

  it("draws an event that crosses an edge clipped, and keeps a bottom-edge sliver inside the grid", () => {
    const top = eventRect(420, 540, WORK_HOURS, HOUR_HEIGHT);
    expect(top).toMatchObject({ top: 0, clippedStart: true, clippedEnd: false });
    expect(top.height).toBe(HOUR_HEIGHT - 1);
    const bottom = eventRect(1190, 1260, WORK_HOURS, HOUR_HEIGHT);
    expect(bottom.clippedEnd).toBe(true);
    expect(bottom.top + bottom.height).toBeLessThanOrEqual(displayGridHeight(WORK_HOURS, HOUR_HEIGHT));
  });
});

describe("scroll positions", () => {
  it("opens an hour before now inside the visible hours", () => {
    expect(initialScrollY(10 * 60, WORK_HOURS, HOUR_HEIGHT)).toBe(HOUR_HEIGHT);
    expect(initialScrollY(8 * 60 + 10, WORK_HOURS, HOUR_HEIGHT)).toBe(0);
  });

  it("opens at the top when now is outside the visible hours", () => {
    expect(initialScrollY(22 * 60, WORK_HOURS, HOUR_HEIGHT)).toBe(0);
    expect(initialScrollY(6 * 60, WORK_HOURS, HOUR_HEIGHT)).toBe(0);
  });

  it("keeps the same hours in place when the range changes", () => {
    // 10:00 is at the top with work hours (y = 96); with the whole day it sits at 480.
    expect(rangeChangeScrollY(96, 480, 0, HOUR_HEIGHT)).toBe(480);
    expect(rangeChangeScrollY(480, 0, 480, HOUR_HEIGHT)).toBe(96);
    expect(rangeChangeScrollY(0, 0, 480, HOUR_HEIGHT)).toBe(0);
  });

  it("reveals a minute half an hour from the top of the new range", () => {
    expect(revealScrollY(360, FULL_DAY_HOURS, HOUR_HEIGHT)).toBe(5.5 * HOUR_HEIGHT);
    expect(revealScrollY(0, FULL_DAY_HOURS, HOUR_HEIGHT)).toBe(0);
  });
});

describe("settings validation (#1164)", () => {
  it("accepts an hour pair with start before end", () => {
    expect(isValidHourPair(8, 20)).toBe(true);
    expect(isValidHourPair(0, 24)).toBe(true);
    expect(isValidHourPair(23, 24)).toBe(true);
  });

  it.each([[20, 8], [8, 8], [-1, 5], [8, 25], [24, 25], [8.5, 20], ["8", 20]])("rejects the pair %s-%s", (s, e) => {
    expect(isValidHourPair(s, e)).toBe(false);
  });

  it("accepts a non-empty list of unique weekdays only", () => {
    expect(isValidWorkingDays([1, 2, 3, 4, 5])).toBe(true);
    expect(isValidWorkingDays([0])).toBe(true);
    for (const bad of [[], [1, 1], [7], [-1], [1.5], ["1"], "1,2", null]) {
      expect(isValidWorkingDays(bad)).toBe(false);
    }
  });
});
