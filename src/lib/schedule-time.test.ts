import { describe, expect, it } from "vitest";

import {
  advancePast,
  describeRecurrence,
  nextOccurrence,
  type Recurrence,
} from "@/lib/schedule-time";

/**
 * Covers the DAILY arm added for the three-channel daily cadence. The weekly
 * and monthly arms are exercised through `schedule.service.test.ts`; these are
 * the cases that are cheapest to get wrong and most expensive to notice — a
 * daily schedule drifting an hour twice a year, or producing four videos after
 * three days of downtime.
 */

describe("DAILY", () => {
  const daily = (over: Partial<Recurrence> = {}): Recurrence => ({
    frequency: "DAILY",
    dayOfWeek: null,
    dayOfMonth: null,
    hour: 6,
    minute: 0,
    timeZone: "Europe/London",
    ...over,
  });

  it("fires later the same day when the time has not passed", () => {
    const after = new Date("2026-03-10T02:00:00Z");

    expect(nextOccurrence(daily(), after).toISOString()).toBe("2026-03-10T06:00:00.000Z");
  });

  it("rolls to tomorrow once the time has passed", () => {
    const after = new Date("2026-03-10T06:00:00Z");

    expect(nextOccurrence(daily(), after).toISOString()).toBe("2026-03-11T06:00:00.000Z");
  });

  // The reason this file exists: a daily schedule that added 24 hours to an
  // instant would drift an hour twice a year. 06:00 local stays 06:00 local.
  it("holds the wall clock across a spring-forward boundary", () => {
    // Europe/London moves to BST in the early hours of 2026-03-29, so 06:00
    // local is 06:00Z on the Saturday and 05:00Z from the Sunday on. The
    // schedule stays at 06:00 for a viewer; it is the UTC instant that moves.
    // Adding 24 hours to an instant would have kept the instant and moved the
    // clock, which is the bug this whole file exists to avoid.
    const saturday = nextOccurrence(daily(), new Date("2026-03-27T07:00:00Z"));
    const sunday = nextOccurrence(daily(), new Date("2026-03-28T07:00:00Z"));
    const monday = nextOccurrence(daily(), new Date("2026-03-29T07:00:00Z"));

    expect(saturday.toISOString()).toBe("2026-03-28T06:00:00.000Z");
    expect(sunday.toISOString()).toBe("2026-03-29T05:00:00.000Z");
    expect(monday.toISOString()).toBe("2026-03-30T05:00:00.000Z");
  });

  it("needs neither a weekday nor a day of the month", () => {
    expect(() => nextOccurrence(daily({ dayOfWeek: null, dayOfMonth: null }), new Date())).not.toThrow();
  });

  // An occurrence is a moment, not a debt — the rule advancePast enforces.
  // A daily schedule dormant for three days must produce one video, not four.
  it("reports the days it stepped over rather than firing them", () => {
    const from = new Date("2026-06-01T06:00:00Z");
    const now = new Date("2026-06-04T09:00:00Z");
    const caught = advancePast(daily(), from, now);

    expect(caught.nextRunAt.toISOString()).toBe("2026-06-05T05:00:00.000Z");
    expect(caught.skippedTotal).toBe(3);
  });

  it("describes itself without naming a day", () => {
    expect(describeRecurrence(daily())).toBe("Every day at 06:00 (Europe/London)");
  });
});
