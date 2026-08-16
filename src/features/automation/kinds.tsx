import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { CalendarClock, Clapperboard, Scissors } from "lucide-react";

import { ReleaseCadenceControls } from "@/features/automation/components/release-cadence-controls";
import { ScheduleControls } from "@/features/automation/components/schedule-controls";
import { SeriesControls } from "@/features/automation/components/series-controls";
import type { AutomationEntry, AutomationKind } from "@/services/automation-list.service";

/**
 * What each kind of automation is called, and how its row behaves.
 *
 * This is the registry that keeps the merged table from being a table with two
 * special cases in it. Every place a row differs by kind — its badge, its
 * icon, the noun for the things it has made, the noun for the things it has
 * queued, the buttons at the end of the row, its entry in the "New automation"
 * menu — is a field here rather than a conditional somewhere in the table. The
 * table itself reads `AUTOMATION_KINDS[entry.kind]` and never asks which kind
 * it got.
 *
 * `Record<AutomationKind, …>` rather than a plain object: adding a name to the
 * union without adding it here is a type error, which is the point. A third
 * kind — the shorts release cadence being built alongside this — arrives as one
 * entry in this object and one loader in automation-list.service.ts, and
 * nothing else changes.
 *
 * Not marked `"use client"`. Two of the fields *are* client components, but the
 * create menu on the server-rendered page reads the labels and hrefs from the
 * same object, and one registry read from both sides is worth more than a
 * server copy and a client copy drifting apart.
 */
export interface AutomationKindMeta {
  /** The badge on the row. Two words at most — it sits beside the name. */
  label: string;
  icon: LucideIcon;
  /** Singular noun for what sits waiting: "topic", "clip". Null for a kind
   *  with no queue of its own. */
  backlogNoun: string | null;
  /** Singular noun for what it has produced: "episode", "video". */
  producedNoun: string;
  /** Where the create form lives, and what the menu entry calls it. */
  newHref: string;
  newLabel: string;
  /** One line under the menu entry, explaining when to pick this rather than
   *  the other. This is the only place in the UI that has to draw the
   *  distinction, which is the whole idea. */
  blurb: string;
  /** The row's controls. Given the whole entry so a kind can use whatever it
   *  needs without the table knowing which fields that is. */
  Controls: (props: { entry: AutomationEntry }) => ReactNode;
}

export const AUTOMATION_KINDS: Record<AutomationKind, AutomationKindMeta> = {
  SERIES: {
    label: "Series",
    icon: Clapperboard,
    backlogNoun: "topic",
    producedNoun: "episode",
    newHref: "/automation/series/new",
    newLabel: "Series",
    blurb:
      "A named show with its own channel, script style and shape. Set it up once and every episode inherits all of it.",
    Controls: ({ entry }) => (
      <SeriesControls
        seriesId={entry.id}
        seriesName={entry.name}
        status={entry.status}
        // "Make one now" refuses an empty queue rather than inventing a
        // subject, so the button is disabled before it is pressed instead of
        // after. `backlog` is never null for this kind.
        queuedTopicCount={entry.backlog ?? 0}
        compact
      />
    ),
  },
  TOPIC_QUEUE: {
    label: "Topic queue",
    icon: CalendarClock,
    backlogNoun: "topic",
    producedNoun: "video",
    newHref: "/automation/schedules/new",
    newLabel: "Topic queue",
    blurb:
      "A list of subjects and a cadence, written with your default script style. The simplest way to keep a channel fed.",
    Controls: ({ entry }) => (
      <ScheduleControls
        scheduleId={entry.id}
        scheduleName={entry.name}
        status={entry.status}
        compact
      />
    ),
  },
  RELEASE_CADENCE: {
    label: "Shorts drip",
    icon: Scissors,
    // "clip", not "short": the row already says Shorts, and "3 shorts banked"
    // beside a Shorts badge reads as a stutter.
    backlogNoun: "clip",
    producedNoun: "short",
    newHref: "/automation/releases/new",
    newLabel: "Shorts drip",
    blurb:
      "Publishes clips already cut from your finished videos, a few a day at times you set. It makes nothing new — it spends what the others banked.",
    Controls: ({ entry }) => (
      <ReleaseCadenceControls
        cadenceId={entry.id}
        channelTitle={entry.name}
        status={entry.status}
        compact
      />
    ),
  },
};

/**
 * Every kind, in the order it is offered.
 *
 * Read off the registry rather than listed again, so a new kind reaches the
 * "New automation" menu by existing — a second list here is a second place to
 * forget. String keys enumerate in insertion order, so the order above is the
 * order on screen.
 */
export const AUTOMATION_KIND_ORDER = Object.keys(
  AUTOMATION_KINDS,
) as AutomationKind[];
