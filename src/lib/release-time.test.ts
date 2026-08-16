import { describe, expect, it } from "vitest";

import {
  advancePastSlots,
  describeSlots,
  firstSlotAfter,
  formatSlot,
  nextSlotAfter,
  normaliseSlots,
  parseSlot,
  type SlotRecurrence,
  upcomingSlots,
} from "@/lib/release-time";

/**
 * No database at all, and deliberately: src/lib/release-time.ts is pure, and
 * the DST behaviour is the part of the shorts drip most likely to be wrong and
 * least likely to be noticed. A clip going out an hour early one Sunday in
 * March is exactly the kind of bug that is discovered months later, from a
 * YouTube timestamp, if at all.
 */

/** How a clock in `timeZone` reads at `instant`, as "YYYY-MM-DD HH:MM". The
 *  assertions below are about wall clocks, so they are written in wall clocks
 *  rather than in offsets the reader has to hold in their head. Same helper,
 *  same reasoning, as schedule.service.test.ts's own. */
function localReading(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant);

  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? "";

  return `${field("year")}-${field("month")}-${field("day")} ${field("hour")}:${field("minute")}`;
}

function cadence(timeZone: string, ...times: string[]): SlotRecurrence {
  return {
    slotMinutes: times.map((time) => {
      const minutes = parseSlot(time);

      if (minutes === null) {
        throw new Error(`Bad fixture time: ${time}`);
      }

      return minutes;
    }),
    timeZone,
  };
}

const HOURS = 60 * 60 * 1000;

describe("release-time — reading and writing times of day", () => {
  it("round-trips a time of day through minutes past midnight", () => {
    expect(parseSlot("08:00")).toBe(480);
    expect(parseSlot("14:30")).toBe(870);
    expect(parseSlot("00:00")).toBe(0);
    expect(parseSlot("23:59")).toBe(1439);

    expect(formatSlot(480)).toBe("08:00");
    expect(formatSlot(870)).toBe("14:30");
    expect(formatSlot(0)).toBe("00:00");
  });

  it("refuses anything that is not a time of day", () => {
    // 24:00 is the trap: it parses as a number and would silently become the
    // next day's midnight, which is a different slot expressed confusingly.
    expect(parseSlot("24:00")).toBeNull();
    expect(parseSlot("08:60")).toBeNull();
    expect(parseSlot("8am")).toBeNull();
    expect(parseSlot("")).toBeNull();
  });

  it("sorts and de-duplicates a hand-edited column rather than trusting it", () => {
    // The column is `Int[]` on a database an operator can reach with a SQL
    // client. Out of order would fire 14:00 before 08:00; a duplicate would
    // fire twice at 14:00 and never at 08:00.
    expect(normaliseSlots([840, 480, 840, 1200])).toEqual([480, 840, 1200]);
    expect(normaliseSlots([-1, 1440, 480, 3.5])).toEqual([480]);
  });

  it("describes a cadence in the operator's own terms", () => {
    expect(describeSlots(cadence("Europe/London", "08:00", "14:00", "20:00"))).toBe(
      "Every day at 08:00, 14:00 and 20:00 (Europe/London)",
    );
    expect(describeSlots(cadence("UTC", "09:30"))).toBe("Every day at 09:30 (UTC)");
  });
});

describe("release-time — the next slot", () => {
  it("takes the next time of day, then wraps to tomorrow's first", () => {
    const recurrence = cadence("UTC", "08:00", "14:00", "20:00");

    expect(nextSlotAfter(recurrence, new Date("2026-08-11T07:00:00Z")).toISOString()).toBe(
      "2026-08-11T08:00:00.000Z",
    );
    expect(nextSlotAfter(recurrence, new Date("2026-08-11T08:00:00Z")).toISOString()).toBe(
      // Strictly after: an inclusive comparison would hand back the slot that
      // was just released, forever.
      "2026-08-11T14:00:00.000Z",
    );
    expect(nextSlotAfter(recurrence, new Date("2026-08-11T23:59:00Z")).toISOString()).toBe(
      "2026-08-12T08:00:00.000Z",
    );
  });

  it("never returns the instant it was given", () => {
    const recurrence = cadence("UTC", "08:00");
    const at = new Date("2026-08-11T08:00:00Z");

    expect(nextSlotAfter(recurrence, at).getTime()).toBeGreaterThan(at.getTime());
  });

  it("refuses a cadence with no slots rather than inventing one", () => {
    expect(() => nextSlotAfter({ slotMinutes: [], timeZone: "UTC" }, new Date())).toThrow(
      /at least one slot/,
    );
  });

  it("does not fire a new cadence immediately on creation", () => {
    // An operator setting up 08:00/14:00/20:00 at 14:05 must not have a clip
    // appear the moment they press Save.
    const at = new Date("2026-08-11T13:05:00Z");
    const first = firstSlotAfter(cadence("UTC", "08:00", "14:00", "20:00"), at);

    expect(first.toISOString()).toBe("2026-08-11T14:00:00.000Z");
    expect(first.getTime()).toBeGreaterThan(at.getTime());
  });
});

describe("release-time — timezones and DST", () => {
  it("keeps 08:00 meaning 08:00 across a spring-forward transition", () => {
    // Europe/London moves to BST at 01:00 on Sunday 29 March 2026. A naive
    // implementation that added 24 hours of milliseconds to Saturday's 08:00
    // would land at 09:00 local on Sunday — the exact bug this module exists to
    // avoid — so the interval here must be 23 hours, not 24.
    const saturday = new Date("2026-03-28T08:00:00Z");
    const sunday = nextSlotAfter(cadence("Europe/London", "08:00"), saturday);

    expect(localReading(sunday, "Europe/London")).toBe("2026-03-29 08:00");
    expect(sunday.toISOString()).toBe("2026-03-29T07:00:00.000Z");
    expect((sunday.getTime() - saturday.getTime()) / HOURS).toBe(23);
  });

  it("keeps 20:00 meaning 20:00 across an autumn-back transition", () => {
    // Europe/London leaves BST at 02:00 on Sunday 25 October 2026, so the
    // Saturday-to-Sunday interval is 25 hours rather than 24.
    const saturday = new Date("2026-10-24T19:00:00Z");
    const sunday = nextSlotAfter(cadence("Europe/London", "20:00"), saturday);

    expect(localReading(sunday, "Europe/London")).toBe("2026-10-25 20:00");
    expect(sunday.toISOString()).toBe("2026-10-25T20:00:00.000Z");
    expect((sunday.getTime() - saturday.getTime()) / HOURS).toBe(25);
  });

  it("shifts a slot the spring-forward deletes to the same clock hour later, never earlier", () => {
    // America/New_York moves to EDT at 02:00 on Sunday 8 March 2026, so 02:30
    // does not happen at all that morning. The rule inherited from
    // `wallClockToInstant` is forward, never back: a clip may go out an hour
    // late in the one week its own local time did not exist, but it must never
    // go out before the operator asked for it.
    const slot = nextSlotAfter(
      cadence("America/New_York", "02:30"),
      new Date("2026-03-08T05:00:00Z"),
    );

    expect(localReading(slot, "America/New_York")).toBe("2026-03-08 03:30");
    expect(slot.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("orders the day's slots by instant, not by the times they were configured as", () => {
    // The reason every function in this module sorts candidates by instant.
    // On 8 March 2026 in New York, 02:30 is deleted and shifts to 03:30, while
    // 03:00 happens as written — so a cadence of 02:30 and 03:00 fires 03:00
    // *first*. Walking the configured order and taking the first future one
    // would return 03:30 and silently drop the 03:00 release entirely.
    const recurrence = cadence("America/New_York", "02:30", "03:00");

    const first = nextSlotAfter(recurrence, new Date("2026-03-08T05:00:00Z"));
    const second = nextSlotAfter(recurrence, first);

    expect(localReading(first, "America/New_York")).toBe("2026-03-08 03:00");
    expect(localReading(second, "America/New_York")).toBe("2026-03-08 03:30");
    expect(second.getTime()).toBeGreaterThan(first.getTime());
  });

  it("collapses two slots the spring-forward maps onto the same instant", () => {
    // 02:00 and 03:00 in New York on 8 March 2026 both resolve to 07:00Z: the
    // first because it was deleted and shifted forward, the second because it
    // happened as written. Two releases claiming the same `scheduledFor` would
    // collide on ReleaseRun's unique constraint — in the worker, one Sunday a
    // year — so the day has one occurrence, not two.
    const recurrence = cadence("America/New_York", "02:00", "03:00");

    const first = nextSlotAfter(recurrence, new Date("2026-03-08T05:00:00Z"));
    const second = nextSlotAfter(recurrence, first);

    expect(first.toISOString()).toBe("2026-03-08T07:00:00.000Z");
    // The next one is the following day's 02:00, not a second 07:00Z.
    expect(localReading(second, "America/New_York")).toBe("2026-03-09 02:00");
  });

  it("fires a repeated hour once, at the earlier of its two instants", () => {
    // America/New_York leaves EDT at 02:00 on Sunday 1 November 2026, so 01:30
    // happens twice, an hour apart. Both genuinely read 01:30 locally, so
    // neither is wrong — but picking deterministically is what stops the
    // cadence firing the same slot twice, and `wallClockToInstant` takes the
    // earlier.
    const recurrence = cadence("America/New_York", "01:30");

    const first = nextSlotAfter(recurrence, new Date("2026-11-01T04:00:00Z"));
    const second = nextSlotAfter(recurrence, first);

    expect(first.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(localReading(first, "America/New_York")).toBe("2026-11-01 01:30");
    // Not 06:30Z, which is the same wall clock an hour later on the same day.
    expect(localReading(second, "America/New_York")).toBe("2026-11-02 01:30");
  });
});

describe("release-time — downtime does not become a burst", () => {
  it("releases one clip for two days of missed slots, and reports the rest", () => {
    // The failure this prevents is not a bill, it is a channel. Six clips
    // dumped onto an audience in ninety seconds is the thing the slots existed
    // to avoid, and it is an algorithmic penalty rather than a busy afternoon.
    const recurrence = cadence("UTC", "08:00", "14:00", "20:00");
    const from = new Date("2026-08-10T08:00:00Z");
    const now = new Date("2026-08-12T09:00:00Z");

    const result = advancePastSlots(recurrence, from, now);

    // Everything strictly between the slot being released and now.
    expect(result.skippedTotal).toBe(6);
    expect(result.skipped.map((slot) => slot.toISOString())).toEqual([
      "2026-08-10T14:00:00.000Z",
      "2026-08-10T20:00:00.000Z",
      "2026-08-11T08:00:00.000Z",
      "2026-08-11T14:00:00.000Z",
      "2026-08-11T20:00:00.000Z",
      "2026-08-12T08:00:00.000Z",
    ]);
    // ...plus the one being released now, which the caller handles. The next
    // slot is genuinely in the future rather than another one owed.
    expect(result.nextReleaseAt.toISOString()).toBe("2026-08-12T14:00:00.000Z");
    expect(result.nextReleaseAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it("caps the rows it writes for a long-dormant cadence but still lands in the future", () => {
    // A cadence nobody ran for a year must not make the worker's poll walk a
    // thousand `Intl` conversions, and must not write a thousand history rows
    // either. The count is a floor rather than a fiction; the next slot is
    // exact.
    const recurrence = cadence("UTC", "08:00", "14:00", "20:00");
    const from = new Date("2025-08-11T08:00:00Z");
    const now = new Date("2026-08-11T09:00:00Z");

    const result = advancePastSlots(recurrence, from, now);

    expect(result.skipped.length).toBeLessThanOrEqual(12);
    expect(result.nextReleaseAt.toISOString()).toBe("2026-08-11T14:00:00.000Z");
  });

  it("reports nothing skipped when the worker is keeping up", () => {
    const recurrence = cadence("UTC", "08:00", "14:00", "20:00");
    const result = advancePastSlots(
      recurrence,
      new Date("2026-08-11T08:00:00Z"),
      new Date("2026-08-11T08:00:02Z"),
    );

    expect(result.skipped).toEqual([]);
    expect(result.skippedTotal).toBe(0);
    expect(result.nextReleaseAt.toISOString()).toBe("2026-08-11T14:00:00.000Z");
  });
});

describe("release-time — the queue's projected times", () => {
  it("lists consecutive future slots so a queue can be paired with them", () => {
    const slots = upcomingSlots(
      cadence("UTC", "08:00", "14:00", "20:00"),
      new Date("2026-08-11T15:00:00Z"),
      4,
    );

    expect(slots.map((slot) => slot.toISOString())).toEqual([
      "2026-08-11T20:00:00.000Z",
      "2026-08-12T08:00:00.000Z",
      "2026-08-12T14:00:00.000Z",
      "2026-08-12T20:00:00.000Z",
    ]);
  });

  it("keeps the local time steady across a transition it spans", () => {
    // The projection an operator reads on the queue page has to survive the
    // same transition the worker does, or the page and the worker would
    // disagree by an hour for a fortnight either side of the clocks changing.
    const slots = upcomingSlots(
      cadence("Europe/London", "08:00", "20:00"),
      new Date("2026-03-28T09:00:00Z"),
      3,
    );

    expect(slots.map((slot) => localReading(slot, "Europe/London"))).toEqual([
      "2026-03-28 20:00",
      "2026-03-29 08:00",
      "2026-03-29 20:00",
    ]);
  });
});
