import { describe, expect, test } from "bun:test";
import {
  computeNextCronRun,
  cronMatchesDate,
  normalizeCronTimezone,
  parseCronExpression,
  validateCronExpression,
} from "../src/schedule";

describe("cron schedule", () => {
  test("parses lists, ranges, steps, and Sunday alias 7", () => {
    const parsed = parseCronExpression("*/15 9-10 * * 1,7");
    expect([...parsed.minute.values]).toEqual([0, 15, 30, 45]);
    expect([...parsed.hour.values]).toEqual([9, 10]);
    expect([...parsed.dayOfWeek.values]).toEqual([1, 0]);
  });

  test("uses standard day-of-month OR day-of-week semantics", () => {
    const expression = "0 0 1 * 1";
    expect(cronMatchesDate(expression, new Date("2026-06-08T00:00:00Z"), "UTC")).toBe(true);
    expect(cronMatchesDate(expression, new Date("2026-07-01T00:00:00Z"), "UTC")).toBe(true);
    expect(cronMatchesDate(expression, new Date("2026-07-02T00:00:00Z"), "UTC")).toBe(false);
  });

  test("computes the next timezone-aware instant", () => {
    const next = computeNextCronRun(
      "*/15 9-10 * * 1-5",
      new Date("2026-07-13T16:07:22Z"),
      "America/Los_Angeles",
    );
    expect(next.toISOString()).toBe("2026-07-13T16:15:00.000Z");
  });

  test("skips a nonexistent daylight-saving local time", () => {
    const next = computeNextCronRun(
      "30 2 * * *",
      new Date("2026-03-08T09:59:00Z"),
      "America/Los_Angeles",
    );
    expect(next.toISOString()).toBe("2026-03-09T09:30:00.000Z");
  });

  test("finds sparse multi-year schedules without minute-by-minute scanning", () => {
    const next = computeNextCronRun("0 0 29 2 *", new Date("2026-03-01T00:00:00Z"), "UTC");
    expect(next.toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });

  test("rejects invalid expressions and timezones", () => {
    expect(validateCronExpression("60 * * * *")).toEqual({
      ok: false,
      error: "cron value 60 is outside 0-59",
    });
    expect(normalizeCronTimezone("Mars/Olympus")).toBeUndefined();
    expect(() => computeNextCronRun("* * * * *", new Date(), "Mars/Olympus")).toThrow(
      "invalid timezone",
    );
  });
});
