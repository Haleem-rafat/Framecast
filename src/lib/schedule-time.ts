/**
 * Turning "every Monday at 09:00 in Europe/London" into an instant.
 *
 * This is the part of recurring automation that quietly breaks twice a year,
 * and it breaks in a way nobody notices until a video arrives an hour early in
 * March. The naive implementation — store the first occurrence as a UTC
 * timestamp and add 7 × 24 × 60 × 60 × 1000 to it — is correct for exactly as
 * long as the operator's zone keeps a constant offset. The moment BST starts,
 * every subsequent occurrence is an hour out, and it stays an hour out until
 * the clocks go back. "09:00" does not mean "a fixed number of milliseconds
 * after the last one"; it means "whatever instant reads 09:00 on a clock in
 * that zone", and the only way to get that right is to do the arithmetic on
 * *calendar fields* and convert to an instant afterwards.
 *
 * No new dependency. Node ships the full IANA database behind
 * `Intl.DateTimeFormat`, which is what `date-fns` v4's own timezone support
 * ultimately reads too, and everything below is built out of two primitives:
 *
 *   - `zonedWallClock` — what does a clock in this zone read at this instant?
 *   - `wallClockToInstant` — which instant makes a clock in this zone read this?
 *
 * The second is the interesting one, because it is not a function: a local time
 * can correspond to zero instants (the hour spring-forward deletes) or two (the
 * hour autumn repeats). See its own comment for what this module does in each
 * case and why.
 *
 * Pure and dependency-free on purpose — no `server-only`, no Prisma — so the
 * DST behaviour can be asserted directly in tests without a database.
 */

/** The kinds of recurrence a schedule can express. Deliberately only two: see
 *  `schedule.service.ts` for why a cron expression was not the answer. */
export type ScheduleFrequencyKind = "WEEKLY" | "MONTHLY";

export interface Recurrence {
  frequency: ScheduleFrequencyKind;
  /** 0 = Sunday … 6 = Saturday, matching `Date.prototype.getUTCDay`. Required
   *  for WEEKLY, ignored for MONTHLY. */
  dayOfWeek: number | null;
  /** 1–31. Required for MONTHLY, ignored for WEEKLY. See `nextOccurrence` for
   *  what happens to the 31st in February. */
  dayOfMonth: number | null;
  /** Local wall-clock time in `timeZone`, never UTC. */
  hour: number;
  minute: number;
  /** IANA zone name, e.g. `Europe/London`. Validated by `isValidTimeZone`. */
  timeZone: string;
}

export interface WallClock {
  year: number;
  /** 1–12, not the 0–11 `Date` uses. Reading `month: 11` as November in one
   *  place and December in another is the classic way this code goes wrong, so
   *  every field in this module is the number a human would write. */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * Formatters are expensive to construct (each one loads and parses zone data)
 * and this module builds one per zone per conversion — several per occurrence,
 * dozens per catch-up walk. Cached by zone name, which is a closed set bounded
 * by the number of distinct timezones the operator's schedules use.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timeZone);

  if (cached) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    // `h23` rather than `hour12: false`: the latter yields "24" for midnight in
    // some ICU builds, which parses to an hour that does not exist and silently
    // shifts the date by a day.
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  FORMATTERS.set(timeZone, formatter);

  return formatter;
}

/**
 * Whether Node recognises this string as an IANA zone.
 *
 * Worth checking at the schema boundary rather than at run time: a schedule
 * stored with a typo'd zone would throw inside the worker's tick loop, on a
 * Monday morning, for a schedule the operator created weeks earlier and has
 * no reason to suspect.
 */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** What a clock in `timeZone` reads at `instant`. */
export function zonedWallClock(instant: Date, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const fields: Record<string, string> = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      fields[part.type] = part.value;
    }
  }

  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour),
    minute: Number(fields.minute),
  };
}

/** The zone's UTC offset at a given instant, in milliseconds — positive east of
 *  Greenwich. Derived rather than looked up: reading the wall clock at an
 *  instant and treating those fields as if they were UTC gives exactly the
 *  offset that was applied. */
function offsetMsAt(instant: Date, timeZone: string): number {
  const wall = zonedWallClock(instant, timeZone);

  return (
    Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) -
    // Seconds and milliseconds are dropped from both sides — no IANA zone has
    // a sub-minute offset in any era this app will ever schedule into.
    Math.floor(instant.getTime() / 60_000) * 60_000
  );
}

/** How far either side of a candidate instant to probe for the zone's two
 *  possible offsets. A day comfortably brackets any DST transition while
 *  staying well inside the gap between consecutive ones. */
const OFFSET_PROBE_MS = 24 * 60 * 60 * 1000;

/** Whether a clock in `timeZone` reads exactly `wall` at `instant`. */
function readsBackAs(instant: number, wall: WallClock, timeZone: string): boolean {
  const check = zonedWallClock(new Date(instant), timeZone);

  return (
    check.year === wall.year &&
    check.month === wall.month &&
    check.day === wall.day &&
    check.hour === wall.hour &&
    check.minute === wall.minute
  );
}

/**
 * The instant at which a clock in `timeZone` reads `wall`.
 *
 * This is not a function in the mathematical sense, and pretending otherwise is
 * how scheduling code goes wrong. A local time can correspond to:
 *
 *   - **one instant**, the ordinary case;
 *   - **none**, for the hour a spring-forward transition deletes — a schedule
 *     set for 02:30 on the second Sunday of March in New York names a time that
 *     simply does not occur that week;
 *   - **two**, for the hour an autumn transition repeats — 01:30 happens twice
 *     that Sunday, an hour apart.
 *
 * So rather than iterating towards an answer and hoping, this enumerates both
 * candidates explicitly. The zone has at most two offsets anywhere near the
 * requested time; probing a day either side yields both, each offset gives one
 * candidate instant, and each candidate is then *verified* by converting back.
 * How many survive that check is exactly which of the three cases applies:
 *
 *   - **Both survive** (or they are the same instant): unambiguous, or the
 *     repeated hour. The earlier is taken. Both genuinely read 01:30 locally,
 *     so neither is wrong, but picking deterministically matters more than
 *     which one — an operator whose weekly video arrives at 01:30 should not
 *     find the interval silently stretched to seven days and one hour, and
 *     `nextOccurrence` needs a stable answer to advance from.
 *   - **One survives**: it is the answer.
 *   - **Neither survives**: the local time was deleted. The *later* candidate
 *     is taken, which is the requested time shifted forward by the size of the
 *     gap — 02:30 becomes 03:30. Forward, never backward: a scheduled run may
 *     be an hour late in the one week of the year its own local time did not
 *     exist, but it must never fire before the operator asked for it.
 */
export function wallClockToInstant(wall: WallClock, timeZone: string): Date {
  const asIfUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);

  const before = offsetMsAt(new Date(asIfUtc - OFFSET_PROBE_MS), timeZone);
  const after = offsetMsAt(new Date(asIfUtc + OFFSET_PROBE_MS), timeZone);

  const candidates = [asIfUtc - before, asIfUtc - after];
  const valid = candidates.filter((candidate) =>
    readsBackAs(candidate, wall, timeZone),
  );

  if (valid.length > 0) {
    return new Date(Math.min(...valid));
  }

  return new Date(Math.max(...candidates));
}

/** Calendar-field date arithmetic, done in UTC on purpose: adding a day to a
 *  *date* has nothing to do with adding 24 hours to an *instant*, and doing it
 *  in UTC keeps the two from being confused. */
function addCalendarDays(
  year: number,
  month: number,
  day: number,
  delta: number,
): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(year, month - 1, day + delta));

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** 0 = Sunday … 6 = Saturday, for a calendar date rather than an instant. */
function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function daysInMonth(year: number, month: number): number {
  // Day 0 of the following month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The first occurrence of `recurrence` strictly after `after`.
 *
 * Strictly, not "at or after": every caller uses this to advance past an
 * occurrence that has just been claimed, and an inclusive comparison would hand
 * back the same instant forever.
 *
 * The search is over *calendar dates* — candidate day, then convert — rather
 * than over instants, which is the whole reason this file exists. Adding seven
 * days to an instant crosses a DST boundary four times a year and lands an hour
 * out; adding seven days to a date and asking for 09:00 on it never does.
 *
 * A monthly schedule set for a day the month does not have (the 31st in
 * February, the 30th in any February) fires on that month's last day rather
 * than skipping the month. Skipping would mean a schedule that silently
 * produces nothing in February and nothing an operator could have predicted
 * from the form they filled in; clamping keeps "monthly" meaning twelve runs a
 * year, and the computed `nextRunAt` is shown in the UI so the shift is visible
 * before it happens rather than after.
 */
export function nextOccurrence(recurrence: Recurrence, after: Date): Date {
  const { timeZone, hour, minute } = recurrence;
  const from = zonedWallClock(after, timeZone);

  if (recurrence.frequency === "WEEKLY") {
    const target = recurrence.dayOfWeek;

    if (target === null) {
      throw new Error("A weekly recurrence needs a dayOfWeek.");
    }

    // Nine days covers both matching weekdays in the window (today's, and the
    // same weekday next week), which is what is needed when today's occurrence
    // has already passed.
    for (let delta = 0; delta <= 9; delta++) {
      const date = addCalendarDays(from.year, from.month, from.day, delta);

      if (weekdayOf(date.year, date.month, date.day) !== target) {
        continue;
      }

      const candidate = wallClockToInstant({ ...date, hour, minute }, timeZone);

      if (candidate.getTime() > after.getTime()) {
        return candidate;
      }
    }

    throw new Error("Could not find the next weekly occurrence.");
  }

  const target = recurrence.dayOfMonth;

  if (target === null) {
    throw new Error("A monthly recurrence needs a dayOfMonth.");
  }

  // Three months rather than two: an occurrence clamped to the end of a short
  // month can land before one clamped in the previous month plus the deleted
  // hour, so a third candidate guarantees the loop always finds a future one.
  for (let delta = 0; delta <= 3; delta++) {
    const rolled = new Date(Date.UTC(from.year, from.month - 1 + delta, 1));
    const year = rolled.getUTCFullYear();
    const month = rolled.getUTCMonth() + 1;
    const day = Math.min(target, daysInMonth(year, month));

    const candidate = wallClockToInstant({ year, month, day, hour, minute }, timeZone);

    if (candidate.getTime() > after.getTime()) {
      return candidate;
    }
  }

  throw new Error("Could not find the next monthly occurrence.");
}

/**
 * How many occurrences are walked past before giving up and jumping straight to
 * the next future one.
 *
 * A schedule that has been dormant for years — an operator who paused nothing
 * but simply stopped running the worker — must not make the tick loop spin
 * through thousands of `Intl` conversions on a Monday morning. Five years of
 * weekly occurrences is far past any real gap and the fallback below is exact
 * anyway; only the *count* of missed occurrences becomes approximate.
 */
const MAX_CATCHUP_OCCURRENCES = 260;

/**
 * How many missed occurrences are worth writing individual history rows for.
 *
 * Run history exists so an operator can answer "why is there no video for the
 * 3rd?", and a year of one-line "nothing was running" rows answers that no
 * better than a season's worth while making the page unreadable. Beyond this
 * the count is still reported; only the individual rows stop.
 */
export const MAX_RECORDED_MISSES = 12;

export interface CatchUp {
  /** The next occurrence strictly in the future. */
  nextRunAt: Date;
  /** Occurrences that fell between the one being run and now, oldest first,
   *  truncated at `MAX_RECORDED_MISSES`. */
  skipped: Date[];
  /** The true number of skipped occurrences, which can exceed
   *  `skipped.length`. */
  skippedTotal: number;
}

/**
 * Where "no burst after downtime" is actually enforced.
 *
 * The failure this prevents: the worker is down from Monday to Thursday, comes
 * back, sees a schedule three occurrences overdue, and produces three videos in
 * three minutes — three scripts, three narrations, three renders, all billed,
 * none of which the operator asked for *now*. The rule is that an occurrence is
 * a moment, not a debt: when a moment passes with nothing running, it is gone.
 *
 * So this walks the recurrence forward from the occurrence that is being run
 * (`from`, the stored `nextRunAt`) until it is past `now`, and reports every
 * occurrence it stepped over. The caller runs exactly one video — for `from` —
 * and writes the stepped-over ones into history as missed, so the gap is
 * visible rather than merely absent.
 */
export function advancePast(recurrence: Recurrence, from: Date, now: Date): CatchUp {
  let cursor = nextOccurrence(recurrence, from);
  const skipped: Date[] = [];
  let skippedTotal = 0;

  for (let step = 0; cursor.getTime() <= now.getTime(); step++) {
    if (step >= MAX_CATCHUP_OCCURRENCES) {
      // Long-dormant schedule. Jumping straight past `now` gives exactly the
      // same `nextRunAt` the loop would have reached, just without the walk;
      // `skippedTotal` is left at the count reached so far, which is a floor
      // rather than a fiction — the rows already written say as much.
      return { nextRunAt: nextOccurrence(recurrence, now), skipped, skippedTotal };
    }

    if (skipped.length < MAX_RECORDED_MISSES) {
      skipped.push(cursor);
    }

    skippedTotal++;

    const following = nextOccurrence(recurrence, cursor);

    // Defence against a recurrence that fails to advance — a bug here would be
    // an infinite loop inside the worker's poll, which takes the whole render
    // pipeline down with it rather than merely mis-scheduling one video.
    if (following.getTime() <= cursor.getTime()) {
      throw new Error("Recurrence failed to advance.");
    }

    cursor = following;
  }

  return { nextRunAt: cursor, skipped, skippedTotal };
}

/**
 * The first occurrence for a schedule that has just been created or edited.
 *
 * Separate from `nextOccurrence` only to name the intent at the call site: a
 * new schedule's first run is "the next time this pattern comes round", never
 * "right now", so an operator who creates a Monday schedule on a Monday
 * afternoon does not get a video the moment they press Save.
 */
export function firstOccurrenceAfter(recurrence: Recurrence, now: Date): Date {
  return nextOccurrence(recurrence, now);
}

/** Weekday names for the UI and for history messages, indexed the same way
 *  `dayOfWeek` is. Kept beside the arithmetic so the two can never disagree
 *  about which number Sunday is. */
export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** An ordinal for a day of the month ("1st", "22nd"), for describing a monthly
 *  schedule in prose. */
export function ordinal(day: number): string {
  const remainderTen = day % 10;
  const remainderHundred = day % 100;

  if (remainderTen === 1 && remainderHundred !== 11) return `${day}st`;
  if (remainderTen === 2 && remainderHundred !== 12) return `${day}nd`;
  if (remainderTen === 3 && remainderHundred !== 13) return `${day}rd`;

  return `${day}th`;
}

/** One line describing when a schedule fires, in the operator's own terms.
 *  Shared by the list, the detail page and the run history so all three phrase
 *  it identically. */
export function describeRecurrence(recurrence: Recurrence): string {
  const time = `${String(recurrence.hour).padStart(2, "0")}:${String(
    recurrence.minute,
  ).padStart(2, "0")}`;

  if (recurrence.frequency === "WEEKLY") {
    const day = WEEKDAY_NAMES[recurrence.dayOfWeek ?? 0];

    return `Every ${day} at ${time} (${recurrence.timeZone})`;
  }

  const day = ordinal(recurrence.dayOfMonth ?? 1);

  return `Monthly on the ${day} at ${time} (${recurrence.timeZone})`;
}
