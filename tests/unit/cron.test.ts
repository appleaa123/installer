import { describe, expect, it } from "vitest";
import { InputError } from "../../src/core/inputs.js";
import { cronTimes, isTimeZone, localTime, nextCronTime, wallClock } from "../../src/core/cron.js";

describe("cron times in a time zone (§10.3)", () => {
  it("reads the wall clock in the zone, not the host's", () => {
    expect(localTime(new Date("2026-10-08T12:00:00.000Z"), "America/Toronto")).toEqual({ minute: 0, hour: 8, day: 8, month: 10, weekday: 4 });
    expect(localTime(new Date("2026-10-08T12:00:00.000Z"), "Asia/Tokyo")).toEqual({ minute: 0, hour: 21, day: 8, month: 10, weekday: 4 });
  });

  it("finds 08:00 on weekdays in Toronto as UTC instants", () => {
    expect(cronTimes("0 8 * * 1-5", "America/Toronto", "2026-10-08T00:00:00.000Z", "2026-10-13T00:00:00.000Z")).toEqual([
      "2026-10-08T12:00:00.000Z", "2026-10-09T12:00:00.000Z", "2026-10-12T12:00:00.000Z",
    ]);
  });

  it("excludes the start and includes the end of the window", () => {
    expect(cronTimes("*/30 * * * *", "UTC", "2026-10-08T12:00:00.000Z", "2026-10-08T13:00:00.000Z")).toEqual(["2026-10-08T12:30:00.000Z", "2026-10-08T13:00:00.000Z"]);
  });

  it("keeps 08:00 local across the end of daylight saving time (one run, an hour later in UTC)", () => {
    expect(cronTimes("0 8 * * *", "America/Toronto", "2026-10-31T00:00:00.000Z", "2026-11-02T23:00:00.000Z")).toEqual([
      "2026-10-31T12:00:00.000Z", "2026-11-01T13:00:00.000Z", "2026-11-02T13:00:00.000Z",
    ]);
  });

  it("runs a time that occurs twice when clocks go back only once", () => {
    expect(cronTimes("30 1 * * *", "America/Toronto", "2026-11-01T00:00:00.000Z", "2026-11-01T12:00:00.000Z")).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"]);
  });

  it("matches either day field when both are restricted, as crontab(5) says", () => {
    expect(cronTimes("0 9 1 * 0", "UTC", "2026-10-31T00:00:00.000Z", "2026-11-09T00:00:00.000Z")).toEqual(["2026-11-01T09:00:00.000Z", "2026-11-08T09:00:00.000Z"]);
    expect(cronTimes("0 9 13 * 5", "UTC", "2026-11-01T00:00:00.000Z", "2026-11-14T00:00:00.000Z")).toEqual(["2026-11-06T09:00:00.000Z", "2026-11-13T09:00:00.000Z"]);
  });

  it("treats day 7 as Sunday", () => {
    expect(cronTimes("0 9 * * 7", "UTC", "2026-11-01T00:00:00.000Z", "2026-11-08T00:00:00.000Z")).toEqual(["2026-11-01T09:00:00.000Z"]);
  });

  it("looks back at most 31 days", () => {
    expect(cronTimes("0 0 1 * *", "UTC", "2025-01-01T00:00:00.000Z", "2026-10-08T00:00:00.000Z")).toEqual(["2026-10-01T00:00:00.000Z"]);
  });

  it("finds the next time, and says when it falls", () => {
    const next = nextCronTime("0 8 * * 1-5", "America/Toronto", "2026-10-09T12:00:00.000Z");
    expect(next).toBe("2026-10-12T12:00:00.000Z");
    expect(wallClock(next ?? "", "America/Toronto")).toBe("Mon 08:00");
    expect(nextCronTime("0 0 30 2 *", "UTC", "2026-10-09T12:00:00.000Z")).toBeNull();
  });

  it("refuses a bad expression and knows real zones", () => {
    expect(() => cronTimes("0 25 * * *", "UTC", "2026-10-08T00:00:00.000Z", "2026-10-09T00:00:00.000Z")).toThrow(InputError);
    expect(isTimeZone("Europe/Paris")).toBe(true);
    expect(isTimeZone("Mars/Base")).toBe(false);
  });
});
