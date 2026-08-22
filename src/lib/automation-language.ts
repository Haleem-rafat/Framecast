/**
 * The words the automation table puts on screen.
 *
 * One file, and every function in it is pure, because the whole complaint this
 * exists to answer was about *language*. An operator reading a list of things
 * that make videos on a timer should see "Every Monday at 6:00 AM, Cairo time"
 * and "Tomorrow at 6:00 AM" — not `0 9 * * 1`, not `2026-08-17T04:00:00.000Z`,
 * and not a 24-hour clock with an IANA identifier in brackets after it.
 *
 * Deliberately separate from src/lib/schedule-time.ts, which owns the *hard*
 * problem — turning a recurrence into an instant across DST — and whose
 * `describeRecurrence` is the sentence the worker's history and the detail
 * pages are written in. Nothing here computes an occurrence; everything here
 * formats one that has already been computed. Keeping the two apart means the
 * table's copy can be rewritten without touching a line of code that decides
 * when money gets spent.
 *
 * Pure and dependency-free on purpose — no `server-only`, no Prisma, no React —
 * so the phrasing can be asserted directly, and so the same function renders a
 * cell on the server and again in the browser.
 */

/** Sunday-first, matching `Date.prototype.getUTCDay` and `Schedule.dayOfWeek`. */
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const MONTH_ABBREVIATIONS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * How many failures in a row stop an automation on its own.
 *
 * Restated rather than imported: the number lives on a private constant in
 * schedule.service.ts (`MAX_CONSECUTIVE_FAILURES`), and that file is the one
 * that must own the *behaviour*. This copy only feeds a sentence — "one more
 * and it stops itself" — so the worst a drift costs is a countdown that is off
 * by one, not a schedule that pauses at the wrong time.
 */
const FAILURES_BEFORE_SELF_PAUSE = 3;

/**
 * Formatters are expensive to construct — each one loads and parses zone data —
 * and a table of twenty rows asks for two per row on every render. Cached by
 * zone name, which is a closed set bounded by the zones the operator's
 * automations actually use. Same trick, same reason, as `formatterFor` in
 * schedule-time.ts.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/**
 * A wall clock reading in some zone, in the numbers a human would write:
 * `month` is 1–12 and `day` is 1–31, never the 0-based forms `Date` uses.
 */
export interface ZonedMoment {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** The day's full name, e.g. "Monday". */
  weekday: string;
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timeZone);

  if (cached) {
    return cached;
  }

  const options: Intl.DateTimeFormatOptions = {
    timeZone,
    // `h23` rather than `hour12: false`, which yields "24" for midnight in some
    // ICU builds — an hour that does not exist and silently shifts the date.
    // The 12-hour text an operator reads is built from these numbers below, so
    // the parsing stays in one representation.
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
  };

  let formatter: Intl.DateTimeFormat;

  try {
    formatter = new Intl.DateTimeFormat("en-US", options);
  } catch {
    // An unresolvable zone is a corrupt row — `timeZone` is validated on the
    // way in — and the correct response is a slightly wrong time rather than a
    // table that throws. The schedule itself is already paused by the worker in
    // this state (`pauseCorruptSchedule`), so the row is reporting a stoppage
    // either way.
    formatter = new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
  }

  FORMATTERS.set(timeZone, formatter);

  return formatter;
}

/** What a clock in `timeZone` reads at `instant`. */
export function zonedMoment(instant: Date, timeZone: string): ZonedMoment {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    hour: Number(read("hour")),
    minute: Number(read("minute")),
    weekday: read("weekday"),
  };
}

/** Calendar days since the epoch, so two wall-clock dates can be subtracted
 *  without either of them being converted back to an instant. */
function civilDay(moment: ZonedMoment): number {
  return Date.UTC(moment.year, moment.month - 1, moment.day) / 86_400_000;
}

/** "6:00 AM", from the 24-hour fields the database stores. */
export function describeTimeOfDay(hour: number, minute: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;

  return `${twelve}:${String(minute).padStart(2, "0")} ${suffix}`;
}

/**
 * "Cairo time" from `Africa/Cairo`.
 *
 * An IANA identifier is the only honest way to *store* a zone and one of the
 * worst ways to show one: the continent prefix is noise, the underscore is a
 * giveaway that this is an identifier rather than a place, and neither helps
 * the operator decide anything. The city alone is what they picked in the form.
 * A zone with no region prefix (`UTC`) is left exactly as it is, because "UTC
 * time" reads like a mistake.
 */
export function describeTimeZone(timeZone: string): string {
  const leaf = timeZone.split("/").at(-1) ?? timeZone;
  const place = leaf.replace(/_/g, " ");

  return timeZone.includes("/") ? `${place} time` : place;
}

export interface CadenceParts {
  frequency: "DAILY" | "WEEKLY" | "MONTHLY";
  /** 0 = Sunday … 6 = Saturday. Set for WEEKLY. */
  dayOfWeek: number | null;
  /** 1–31. Set for MONTHLY. */
  dayOfMonth: number | null;
  hour: number;
  minute: number;
  timeZone: string;
}

/**
 * The rule, as a sentence: "Every Monday at 6:00 AM, Cairo time".
 *
 * The zone is named in this line and nowhere else in a row. It belongs on the
 * rule rather than on the next-run time because it is a property of how the
 * automation was set up, not of one occurrence — and repeating it on every
 * time in the table would be four extra words per row saying the same thing.
 */
export function describeCadence(parts: CadenceParts): string {
  const time = describeTimeOfDay(parts.hour, parts.minute);
  const zone = describeTimeZone(parts.timeZone);

  if (parts.frequency === "WEEKLY") {
    return `Every ${WEEKDAY_NAMES[parts.dayOfWeek ?? 0]} at ${time}, ${zone}`;
  }

  return `The ${ordinal(parts.dayOfMonth ?? 1)} of every month at ${time}, ${zone}`;
}

/**
 * The next occurrence, said the way somebody would say it out loud.
 *
 * Read in the automation's *own* zone rather than the reader's, which is the
 * one choice here worth defending. A weekly show set to 6:00 AM in Cairo fires
 * at 6:00 AM in Cairo whoever is looking, so "Monday at 6:00 AM" is true on
 * every screen — and it is the same string on the server and in the browser,
 * which a viewer-local rendering could not promise. The zone is named on the
 * cadence line directly above it.
 *
 * `now` is a parameter rather than a `new Date()` inside so the relative
 * branches can be asserted at all.
 */
export function describeNextRun(next: Date, timeZone: string, now: Date): string {
  const there = zonedMoment(next, timeZone);
  const time = describeTimeOfDay(there.hour, there.minute);
  const days = civilDay(there) - civilDay(zonedMoment(now, timeZone));

  // An occurrence in the past means nothing has claimed it yet — a worker that
  // is down, or one that has not polled since it came due. "Due now" is what
  // the operator can act on; the date it was originally due would read as a
  // schedule stuck in the past, which is a different and scarier problem.
  if (days < 0) return "Due now";
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Tomorrow at ${time}`;
  // Inside the coming week a weekday name is unambiguous and needs no date.
  // Past that it stops being — "Monday" three weeks out is three Mondays — so
  // the date takes over.
  if (days < 7) return `${there.weekday} at ${time}`;

  return `${there.day} ${MONTH_ABBREVIATIONS[there.month - 1]} at ${time}`;
}

export type AutomationHealthTone = "healthy" | "warning" | "paused" | "stopped";

export interface AutomationHealth {
  tone: AutomationHealthTone;
  /** Two or three words for the badge. */
  label: string;
  /** One sentence under it, or null when the label says everything. */
  detail: string | null;
  /**
   * How loudly this row is asking for attention. The table sorts on it, and
   * the server orders on it, so the thing that has stopped is the thing at the
   * top rather than the thing with the alphabetically earliest name.
   */
  rank: number;
}

/**
 * Whether this automation is working, and if not, whose doing that was.
 *
 * The distinction the whole column exists for is the last two branches. A
 * schedule the operator paused by hand and a schedule that gave up after three
 * failed runs are both `status: PAUSED`, and until now they looked identical in
 * a list — same grey badge, same "Paused". They are not remotely the same
 * event: the first is a decision, the second is a fault the operator was by
 * definition not watching when it happened, and it will keep not running until
 * somebody reads the reason.
 *
 * The database already separates them and says so in the schema:
 * `Schedule.pausedReason` is "null for an ACTIVE schedule and for one the
 * operator paused by hand without comment", and every self-pause path —
 * repeated failures, an empty queue, a deleted project, an unschedulable
 * recurrence — writes a sentence into it. So the presence of a reason *is* the
 * signal, and no new column was needed to tell them apart.
 *
 * That held until something paused an automation deliberately AND said why.
 * Setting up the daily cadence did exactly that — six automations paused on
 * purpose, each carrying a sentence explaining the decision — and every one of
 * them reported that it had given up. An inference that is only correct while
 * nobody writes a helpful message is not a signal, it is a coincidence, so
 * `pausedByOperator` now records the actor outright.
 *
 * The old inference survives as the fallback for rows written before the
 * column: `pausedByOperator: false` with no reason still means the operator
 * paused by hand, because that is what those rows meant when they were
 * written. Only false-with-a-reason is a self-pause.
 *
 * The warning branch is the one that catches the fault before it stops
 * anything: a running automation with failures behind it is still running, and
 * saying "one more and it stops itself" is worth more than the notice that
 * arrives after it already has.
 */
export function describeHealth(automation: {
  status: "ACTIVE" | "PAUSED";
  pausedReason: string | null;
  /** Whether a human stopped it. Optional so a caller that has not been
   *  updated still compiles, and absent reads as false — which lands on the
   *  legacy fallback below rather than on a wrong answer. */
  pausedByOperator?: boolean;
  consecutiveFailures: number;
}): AutomationHealth {
  if (automation.status === "PAUSED") {
    if (automation.pausedReason && !automation.pausedByOperator) {
      return {
        tone: "stopped",
        label: "Stopped on its own",
        detail: automation.pausedReason,
        rank: 3,
      };
    }

    return {
      tone: "paused",
      label: "Paused by you",
      // The operator's own note when there is one. "It will not make anything
      // until you resume it" is what to say when nobody wrote a reason, not
      // something to say instead of one they did write.
      detail: automation.pausedReason ?? "It will not make anything until you resume it.",
      rank: 2,
    };
  }

  if (automation.consecutiveFailures > 0) {
    const remaining = FAILURES_BEFORE_SELF_PAUSE - automation.consecutiveFailures;

    return {
      tone: "warning",
      label: "Running",
      detail:
        remaining > 0
          ? `${countOf(automation.consecutiveFailures, "run")} in a row failed — ${
              remaining === 1 ? "one more" : `${remaining} more`
            } and it stops itself.`
          : `${countOf(automation.consecutiveFailures, "run")} in a row failed. It stops itself at the next one.`,
      rank: 1,
    };
  }

  return { tone: "healthy", label: "Running", detail: null, rank: 0 };
}

/** "1 run" / "3 runs". Small enough not to earn a dependency, common enough
 *  here to be worth not writing five times. */
export function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st. */
function ordinal(value: number): string {
  const lastTwo = value % 100;

  if (lastTwo >= 11 && lastTwo <= 13) return `${value}th`;

  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}
