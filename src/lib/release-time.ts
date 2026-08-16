/**
 * Turning "08:00, 14:00 and 20:00 in Europe/London" into the next instant.
 *
 * The shorts drip's half of src/lib/schedule-time.ts, and built out of that
 * module's primitives rather than beside them: `wallClockToInstant` already
 * knows the three things a local time can mean (one instant, none, or two —
 * see its own comment), and re-deriving that here would be a second chance to
 * get DST wrong in a feature that fires three times a day instead of once a
 * week.
 *
 * What is genuinely new is that a release cadence has *several* times of day
 * rather than one, and that turns out not to be a loop over `nextOccurrence`.
 * Two reasons:
 *
 *   1. **Slots are not independent.** "The next release" is the earliest
 *      upcoming instant across the whole set, so the set has to be evaluated
 *      together.
 *   2. **Ascending slots do not produce ascending instants.** On the morning a
 *      spring-forward deletes an hour, a slot at 02:30 fires at 03:30 (see
 *      `wallClockToInstant`: a deleted local time is shifted *forward*, never
 *      back), so a cadence of `02:30, 03:00` fires 03:00 before 02:30 that day.
 *      Taking the first slot in configured order whose instant is in the future
 *      would silently drop the 03:00 release. Every function below therefore
 *      sorts candidates *by instant*, never by slot.
 *
 * Pure and dependency-free, like schedule-time.ts and for the same reason: the
 * DST behaviour is the part most likely to be wrong and least likely to be
 * noticed, so it must be assertable without a database.
 */

import {
  addCalendarDays,
  MAX_RECORDED_MISSES,
  wallClockToInstant,
  zonedWallClock,
} from "@/lib/schedule-time";

/** Minutes in a day. A slot is `0 … MINUTES_PER_DAY - 1`; 1440 would be the
 *  next day's midnight, which is a different slot expressed confusingly. */
export const MINUTES_PER_DAY = 24 * 60;

/**
 * A channel's release times: when, and in whose clock.
 *
 * Deliberately not a `Recurrence`. That type answers "which day", because a
 * schedule fires on one of them; a cadence fires every day and answers "which
 * times" instead. Sharing one type would mean a `dayOfWeek` that must be null
 * here and a `slotMinutes` that must be empty there.
 */
export interface SlotRecurrence {
  /** Minutes past local midnight. Order and duplicates do not matter — every
   *  function here normalises first — because this comes back off a `Int[]`
   *  column an operator can reach with a SQL client. */
  slotMinutes: readonly number[];
  /** IANA zone name, e.g. `Europe/London`. Validate with `isValidTimeZone`
   *  from schedule-time.ts before storing. */
  timeZone: string;
}

/**
 * How many days of candidates to consider.
 *
 * Two would do: every cadence has at least one slot, so tomorrow always
 * contains a future one. The third is for the pathological case where a zone's
 * offset moves far enough that today's candidates all land behind `after` —
 * it costs three extra `Intl` conversions on a query that runs twice a minute
 * and removes the need to reason about whether two is provably enough.
 */
const CANDIDATE_DAYS = 3;

/**
 * How many slots are walked past before jumping straight to the next future
 * one.
 *
 * Three a day makes 200 about nine weeks of downtime, which is far past any
 * real gap — and the fallback is exact anyway (see `advancePastSlots`); only
 * the *count* of missed slots becomes a floor rather than a total. Lower than
 * schedule-time.ts's own 260 because these occurrences are dozens of times
 * denser, and the point of the cap is to bound the work, not the calendar.
 */
const MAX_CATCHUP_SLOTS = 200;

/** Sorted, de-duplicated and bounds-checked. Every entry point starts here, so
 *  a column hand-edited to `[840, 480, 480]` behaves as `[480, 840]` rather
 *  than firing twice at 14:00 and never at 08:00. */
export function normaliseSlots(slotMinutes: readonly number[]): number[] {
  const seen = new Set<number>();

  for (const minutes of slotMinutes) {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes >= MINUTES_PER_DAY) {
      continue;
    }
    seen.add(minutes);
  }

  return [...seen].sort((a, b) => a - b);
}

/** `480` → `"08:00"`. The form's `<input type="time">` speaks this, and so does
 *  every sentence shown to the operator. */
export function formatSlot(minutes: number): string {
  const hour = Math.floor(minutes / 60);

  return `${String(hour).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** `"08:00"` → `480`, or null for anything that is not a time of day. The one
 *  place a string from a form becomes a number, so the schema and the form
 *  agree about what is acceptable. */
export function parseSlot(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());

  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (hour > 23 || minute > 59) {
    return null;
  }

  return hour * 60 + minute;
}

/** One line describing when a cadence releases, in the operator's own terms.
 *  Built once in the service so the list, the detail page and the history all
 *  phrase it identically — the same job `describeRecurrence` does for a
 *  schedule. */
export function describeSlots(recurrence: SlotRecurrence): string {
  const slots = normaliseSlots(recurrence.slotMinutes).map(formatSlot);

  if (slots.length === 0) {
    return `No release times set (${recurrence.timeZone})`;
  }

  const times =
    slots.length === 1
      ? slots[0]
      : `${slots.slice(0, -1).join(", ")} and ${slots[slots.length - 1]}`;

  return `Every day at ${times} (${recurrence.timeZone})`;
}

/**
 * Every instant this cadence fires on the local days around `after`, in
 * chronological order and de-duplicated.
 *
 * De-duplication is not tidiness. On a spring-forward morning two slots inside
 * the deleted hour both shift forward onto the same instant, and two releases
 * claiming the same `scheduledFor` would collide on `ReleaseRun`'s unique
 * constraint — a real error, in the worker, one Sunday a year. Collapsing them
 * to a single occurrence is the honest reading: the operator asked for a
 * release at a local time that happened once, so it happens once.
 */
function candidateInstants(recurrence: SlotRecurrence, after: Date): number[] {
  const slots = normaliseSlots(recurrence.slotMinutes);

  if (slots.length === 0) {
    throw new Error("A release cadence needs at least one slot.");
  }

  const from = zonedWallClock(after, recurrence.timeZone);
  const instants = new Set<number>();

  for (let delta = 0; delta < CANDIDATE_DAYS; delta++) {
    const date = addCalendarDays(from.year, from.month, from.day, delta);

    for (const minutes of slots) {
      instants.add(
        wallClockToInstant(
          {
            ...date,
            hour: Math.floor(minutes / 60),
            minute: minutes % 60,
          },
          recurrence.timeZone,
        ).getTime(),
      );
    }
  }

  return [...instants].sort((a, b) => a - b);
}

/**
 * The first slot strictly after `after`.
 *
 * Strictly, not "at or after": callers use this to advance past a slot that has
 * just been claimed, and an inclusive comparison would hand back the same
 * instant forever — the drip equivalent of a worker publishing the same clip on
 * every poll.
 */
export function nextSlotAfter(recurrence: SlotRecurrence, after: Date): Date {
  const cutoff = after.getTime();
  const next = candidateInstants(recurrence, after).find((instant) => instant > cutoff);

  if (next === undefined) {
    throw new Error("Could not find the next release slot.");
  }

  return new Date(next);
}

/**
 * The first slot for a cadence that has just been created or edited.
 *
 * Separate from `nextSlotAfter` only to name the intent at the call site: a new
 * cadence's first release is "the next time one of these times comes round",
 * never "right now", so an operator setting up 08:00/14:00/20:00 at 14:05 does
 * not get a short on YouTube the moment they press Save.
 */
export function firstSlotAfter(recurrence: SlotRecurrence, now: Date): Date {
  return nextSlotAfter(recurrence, now);
}

export interface SlotCatchUp {
  /** The next slot strictly in the future. */
  nextReleaseAt: Date;
  /** Slots that fell between the one being released and now, oldest first,
   *  truncated at `MAX_RECORDED_MISSES`. */
  skipped: Date[];
  /** The true number of skipped slots, which can exceed `skipped.length`. */
  skippedTotal: number;
}

/**
 * Where "no burst after downtime" is enforced for the drip.
 *
 * The failure this prevents is different from a schedule's and worse. A
 * schedule that catches up bills the operator for videos they did not ask for
 * now; a cadence that catches up dumps a day and a half of banked shorts onto a
 * channel in ninety seconds — which is not merely untidy, it is the thing the
 * slots existed to prevent. The operator chose 08:00, 14:00 and 20:00 because
 * that is when their audience is awake, and eleven clips at 16:20 on a
 * Wednesday is an algorithmic penalty, not a busy afternoon.
 *
 * So the rule is identical to `advancePast`'s: a slot is a moment, not a debt.
 * This walks forward from the slot being released until it is past `now`, and
 * reports every slot it stepped over so the caller can write them into history
 * as MISSED. The gap becomes visible rather than merely absent.
 */
export function advancePastSlots(
  recurrence: SlotRecurrence,
  from: Date,
  now: Date,
): SlotCatchUp {
  let cursor = nextSlotAfter(recurrence, from);
  const skipped: Date[] = [];
  let skippedTotal = 0;

  for (let step = 0; cursor.getTime() <= now.getTime(); step++) {
    if (step >= MAX_CATCHUP_SLOTS) {
      // A long-dormant cadence. Jumping straight past `now` gives exactly the
      // same `nextReleaseAt` the loop would have reached, just without the
      // walk; `skippedTotal` stays at the count reached so far, which is a
      // floor rather than a fiction — the rows already written say as much.
      return { nextReleaseAt: nextSlotAfter(recurrence, now), skipped, skippedTotal };
    }

    if (skipped.length < MAX_RECORDED_MISSES) {
      skipped.push(cursor);
    }

    skippedTotal++;

    const following = nextSlotAfter(recurrence, cursor);

    // Defence against a cadence that fails to advance. A bug here is an
    // infinite loop inside the worker's poll, which takes the render pipeline
    // down with it rather than merely mis-timing one clip.
    if (following.getTime() <= cursor.getTime()) {
      throw new Error("Release cadence failed to advance.");
    }

    cursor = following;
  }

  return { nextReleaseAt: cursor, skipped, skippedTotal };
}

/**
 * The next `count` slots from `after` onwards, oldest first.
 *
 * Only the UI needs this, and it is what turns the queue from a list into an
 * answer: pairing banked shorts with upcoming slots is how the operator reads
 * "this clip goes out at 20:00 today, that one at 08:00 tomorrow" instead of
 * counting rows and doing the arithmetic themselves.
 */
export function upcomingSlots(
  recurrence: SlotRecurrence,
  after: Date,
  count: number,
): Date[] {
  const slots: Date[] = [];
  let cursor = after;

  for (let index = 0; index < count; index++) {
    cursor = nextSlotAfter(recurrence, cursor);
    slots.push(cursor);
  }

  return slots;
}
