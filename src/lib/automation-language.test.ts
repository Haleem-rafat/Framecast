import { describe, expect, it } from "vitest";

import {
  countOf,
  describeCadence,
  describeHealth,
  describeNextRun,
  describeTimeOfDay,
  describeTimeZone,
  zonedMoment,
} from "@/lib/automation-language";

/**
 * The automation table's copy, asserted as copy.
 *
 * Worth pinning down because these strings are the feature: the complaint that
 * produced this file was that an operator could not tell two lists apart, and
 * the fix is largely a matter of what the rows say. A regression here does not
 * throw — it quietly puts "09:00 (Africa/Cairo)" back on screen, or makes a
 * schedule somebody paused by hand look identical to one that broke.
 *
 * No database and no clock: every function under test is pure and takes `now`
 * as an argument, which is why it takes `now` as an argument.
 */

describe("describeTimeOfDay", () => {
  it("reads midnight and noon as 12, not 0", () => {
    expect(describeTimeOfDay(0, 0)).toBe("12:00 AM");
    expect(describeTimeOfDay(12, 0)).toBe("12:00 PM");
  });

  it("keeps a leading zero on the minutes", () => {
    expect(describeTimeOfDay(6, 5)).toBe("6:05 AM");
    expect(describeTimeOfDay(18, 30)).toBe("6:30 PM");
  });
});

describe("describeTimeZone", () => {
  it("keeps the city and drops the identifier around it", () => {
    expect(describeTimeZone("Africa/Cairo")).toBe("Cairo time");
    expect(describeTimeZone("America/New_York")).toBe("New York time");
    expect(describeTimeZone("America/Argentina/Buenos_Aires")).toBe(
      "Buenos Aires time",
    );
  });

  it("leaves a zone with no place in it alone", () => {
    expect(describeTimeZone("UTC")).toBe("UTC");
  });
});

describe("describeCadence", () => {
  it("says a weekly rule as a sentence, in 12-hour time", () => {
    expect(
      describeCadence({
        frequency: "WEEKLY",
        dayOfWeek: 1,
        dayOfMonth: null,
        hour: 6,
        minute: 0,
        timeZone: "Africa/Cairo",
      }),
    ).toBe("Every Monday at 6:00 AM, Cairo time");
  });

  it("ordinalises the day of the month", () => {
    const monthly = (dayOfMonth: number) =>
      describeCadence({
        frequency: "MONTHLY",
        dayOfWeek: null,
        dayOfMonth,
        hour: 21,
        minute: 15,
        timeZone: "UTC",
      });

    expect(monthly(1)).toBe("The 1st of every month at 9:15 PM, UTC");
    expect(monthly(2)).toBe("The 2nd of every month at 9:15 PM, UTC");
    expect(monthly(3)).toBe("The 3rd of every month at 9:15 PM, UTC");
    expect(monthly(11)).toBe("The 11th of every month at 9:15 PM, UTC");
    expect(monthly(21)).toBe("The 21st of every month at 9:15 PM, UTC");
  });
});

describe("zonedMoment", () => {
  it("reads the wall clock in the zone asked for, not the host's", () => {
    // 02:00 UTC is 06:00 in Dubai. A zone that has never observed daylight
    // saving is deliberate throughout this file: the behaviour under test is
    // the phrasing, and pinning it to a country's DST policy would make these
    // assertions fail on a tzdata update rather than on a real regression.
    expect(zonedMoment(new Date("2026-08-17T02:00:00Z"), "Asia/Dubai")).toEqual({
      year: 2026,
      month: 8,
      day: 17,
      hour: 6,
      minute: 0,
      weekday: "Monday",
    });
  });

  it("falls back to UTC rather than throwing on a corrupt zone", () => {
    expect(zonedMoment(new Date("2026-08-17T02:00:00Z"), "Not/AZone")).toMatchObject({
      day: 17,
      hour: 2,
    });
  });
});

describe("describeNextRun", () => {
  const zone = "Asia/Dubai";
  // Sunday 16 August 2026, 10:00 in Dubai.
  const now = new Date("2026-08-16T06:00:00Z");

  it("says today and tomorrow by name", () => {
    expect(describeNextRun(new Date("2026-08-16T14:00:00Z"), zone, now)).toBe(
      "Today at 6:00 PM",
    );
    expect(describeNextRun(new Date("2026-08-17T02:00:00Z"), zone, now)).toBe(
      "Tomorrow at 6:00 AM",
    );
  });

  it("uses the weekday for anything else inside the coming week", () => {
    expect(describeNextRun(new Date("2026-08-21T02:00:00Z"), zone, now)).toBe(
      "Friday at 6:00 AM",
    );
  });

  it("switches to a date once a weekday would be ambiguous", () => {
    // Sixteen days out: "Tuesday" would be the third Tuesday from here.
    expect(describeNextRun(new Date("2026-09-01T02:00:00Z"), zone, now)).toBe(
      "1 Sep at 6:00 AM",
    );
  });

  it("calls an occurrence that has already passed due rather than dating it", () => {
    expect(describeNextRun(new Date("2026-08-10T02:00:00Z"), zone, now)).toBe(
      "Due now",
    );
  });

  it("counts the days in the automation's zone, not the reader's", () => {
    // 20:00 UTC on the 16th is already midnight on the 17th in Dubai, so this
    // is "tomorrow" to the automation and still tonight to a reader in London.
    expect(describeNextRun(new Date("2026-08-16T20:00:00Z"), zone, now)).toBe(
      "Tomorrow at 12:00 AM",
    );
  });
});

describe("describeHealth", () => {
  it("says nothing extra about an automation that is simply working", () => {
    expect(
      describeHealth({ status: "ACTIVE", pausedReason: null, consecutiveFailures: 0 }),
    ).toEqual({ tone: "healthy", label: "Running", detail: null, rank: 0 });
  });

  it("separates a pause the operator chose from one the automation took", () => {
    const byHand = describeHealth({
      status: "PAUSED",
      pausedReason: null,
      consecutiveFailures: 0,
    });
    const byItself = describeHealth({
      status: "PAUSED",
      pausedReason: "The topic queue is empty.",
      consecutiveFailures: 0,
    });

    expect(byHand.label).toBe("Paused by you");
    expect(byHand.tone).toBe("paused");
    expect(byItself.label).toBe("Stopped on its own");
    expect(byItself.tone).toBe("stopped");
    expect(byItself.detail).toBe("The topic queue is empty.");
    // The one that nobody asked for outranks the one that somebody did, so a
    // sort by health puts the fault above the decision.
    expect(byItself.rank).toBeGreaterThan(byHand.rank);
  });

  it("warns a running automation before the failures stop it", () => {
    expect(
      describeHealth({ status: "ACTIVE", pausedReason: null, consecutiveFailures: 2 }),
    ).toMatchObject({
      tone: "warning",
      label: "Running",
      detail: "2 runs in a row failed — one more and it stops itself.",
    });

    expect(
      describeHealth({ status: "ACTIVE", pausedReason: null, consecutiveFailures: 1 }),
    ).toMatchObject({
      detail: "1 run in a row failed — 2 more and it stops itself.",
    });
  });

  it("still reads correctly past the point it should have stopped", () => {
    expect(
      describeHealth({ status: "ACTIVE", pausedReason: null, consecutiveFailures: 4 }),
    ).toMatchObject({
      tone: "warning",
      detail: "4 runs in a row failed. It stops itself at the next one.",
    });
  });
});

describe("countOf", () => {
  it("pluralises on one, not on zero", () => {
    expect(countOf(0, "topic")).toBe("0 topics");
    expect(countOf(1, "topic")).toBe("1 topic");
    expect(countOf(2, "topic")).toBe("2 topics");
  });
});
