"use client";

import { useMemo, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, CalendarClock } from "lucide-react";

import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { Badge } from "@/components/ui/badge";
import { AUTOMATION_KINDS } from "@/features/automation/kinds";
import {
  countOf,
  describeHealth,
  describeNextRun,
  type AutomationHealthTone,
} from "@/lib/automation-language";
import type { AutomationEntry } from "@/services/automation-list.service";

/**
 * Every recurring automation, in one table.
 *
 * ## What this replaces, and why
 *
 * Two lists that were the same idea drawn two different ways: series as a
 * `DataTable`, schedules as a stack of `Card`s, with a series' cadence
 * appearing a third time on the schedules page as a row pointing back at the
 * first. An operator looking for "the thing that posts to my finance channel on
 * Mondays" had to know which internal model it was stored as before they could
 * decide which screen to open. That is the bug; one table is the fix.
 *
 * ## Why it is not a table with two special cases in it
 *
 * Nothing below asks what kind a row is. Every difference — the badge, the
 * icon, the noun for what it has made, the noun for what is queued, the buttons
 * at the end of the row — is looked up in `AUTOMATION_KINDS`, so a third kind
 * (the shorts release cadence being built alongside this) becomes rows here by
 * adding one entry to that registry and one loader to the service. There is no
 * `if (kind === "SERIES")` anywhere in this file, deliberately: the moment
 * there is one, there will be three.
 *
 * ## The columns, and the questions they answer
 *
 * An operator looking at this screen is asking five things, and there is one
 * column for each: *what is this* (name, kind badge, cadence in plain English),
 * *which channel*, *when does it next fire*, *is it working*, *what has it
 * produced*. Project is a sixth, hidden behind the column toggle for the
 * operators who file one channel's work across several — it answers "where will
 * the video appear", which is a question you ask after the other five.
 *
 * Not here: cron expressions, ISO timestamps, IANA zone identifiers, the word
 * "schedule" used to mean two different things. See src/lib/automation-language.ts.
 */

/**
 * How each health tone is drawn.
 *
 * "Running" is the same filled badge whether or not there are failures behind
 * it, because a running automation *is* running and a second badge colour for
 * "running but worried" would compete with the one that means stopped. The
 * worry is said in words underneath instead, where it can name the number.
 *
 * The two paused tones are the distinction this column exists for. Grey is a
 * decision the operator made; red is a fault they have not seen yet.
 */
const HEALTH_VARIANT: Record<
  AutomationHealthTone,
  "default" | "secondary" | "destructive"
> = {
  healthy: "default",
  warning: "default",
  paused: "secondary",
  stopped: "destructive",
};

export function AutomationTable({
  automations,
  empty,
}: {
  automations: AutomationEntry[];
  /** The page's own `EmptyState`, shown instead of the table when there is
   *  nothing at all. Owned by the page because what to do next is a decision
   *  about the whole screen, not about this component. */
  empty: ReactNode;
}) {
  const columns = useMemo<DataTableColumn<AutomationEntry>[]>(
    () => [
      {
        id: "name",
        header: "Automation",
        cell: (entry) => {
          const kind = AUTOMATION_KINDS[entry.kind];
          const Icon = kind.icon;

          return (
            <div className="max-w-[22rem] space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={entry.href}
                  className="truncate font-medium underline-offset-4 hover:underline"
                >
                  {entry.name}
                </Link>
                {/* The kind, said out loud on every row. The old screens
                    expressed it by *which page you were on*, which is exactly
                    the knowledge an operator should not need to have. */}
                <Badge variant="outline">
                  <Icon />
                  {kind.label}
                </Badge>
              </div>
              {/* The cadence sits under the name rather than in a column of its
                  own: it is a sentence, not a value, so it sorts meaninglessly
                  and would cost the width that the actions column needs. */}
              <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <CalendarClock className="size-3 shrink-0" />
                {entry.cadence}
              </p>
            </div>
          );
        },
        sortValue: (entry) => entry.name,
        // Everything findable about a row, including the things no column
        // shows: the subject queued up next, and the kind by name — so typing
        // "series" narrows to shows without a filter control existing.
        filterValue: (entry) =>
          [
            entry.name,
            AUTOMATION_KINDS[entry.kind].label,
            entry.cadence,
            entry.channel?.title ?? "",
            entry.project?.name ?? "",
            entry.nextUp ?? "",
          ].join(" "),
        alwaysVisible: true,
      },
      {
        id: "channel",
        header: "Channel",
        cell: (entry) =>
          entry.channel ? (
            <Link
              href={`/channels/${entry.channel.id}`}
              className="underline-offset-4 hover:underline"
            >
              {entry.channel.title}
            </Link>
          ) : (
            // Not a dash. A cadence whose project publishes nowhere will
            // produce videos that sit there, and that is worth a sentence
            // rather than a blank cell the operator has to interpret.
            <span className="text-muted-foreground">No channel yet</span>
          ),
        sortValue: (entry) => entry.channel?.title ?? null,
        cellClassName: "text-sm",
      },
      {
        id: "project",
        header: "Project",
        cell: (entry) => entry.project?.name ?? "—",
        sortValue: (entry) => entry.project?.name ?? null,
        cellClassName: "text-muted-foreground text-sm",
      },
      {
        id: "nextRunAt",
        header: "Next run",
        cell: (entry) => {
          const kind = AUTOMATION_KINDS[entry.kind];
          const queueEmpty = entry.backlog === 0;

          return (
            <div className="space-y-0.5">
              {entry.status === "ACTIVE" && entry.nextRunAt ? (
                // `suppressHydrationWarning` because the wording depends on
                // today's date: a render that straddles midnight can say
                // "Tomorrow" on the server and "Today" in the browser. The
                // *time* is stable — it is read in the automation's own zone,
                // not the reader's — so only the relative word can differ, and
                // it self-corrects on the next render.
                <span suppressHydrationWarning>
                  {describeNextRun(entry.nextRunAt, entry.timeZone, new Date())}
                </span>
              ) : (
                // A time on a paused row would advertise a video that is not
                // coming.
                <span className="text-muted-foreground">Nothing due</span>
              )}
              {entry.backlog !== null && kind.backlogNoun && (
                // The queue count rides in this cell rather than taking a
                // column: "when is the next one, and is there anything left to
                // make it from" is one question, and an empty queue is
                // precisely what makes the time above it a lie.
                <p
                  className={
                    queueEmpty
                      ? "text-destructive text-xs"
                      : "text-muted-foreground text-xs"
                  }
                >
                  {queueEmpty
                    ? `Nothing queued — add a ${kind.backlogNoun}`
                    : `${countOf(entry.backlog, kind.backlogNoun)} waiting`}
                </p>
              )}
            </div>
          );
        },
        // Paused rows sort to the bottom in both directions rather than
        // clustering at whichever end a null lands on — the same treatment
        // `DataTable` gives every other missing value.
        sortValue: (entry) => (entry.status === "ACTIVE" ? entry.nextRunAt : null),
        cellClassName: "text-sm",
      },
      {
        id: "health",
        header: "Status",
        cell: (entry) => {
          const health = describeHealth(entry);

          return (
            <div className="max-w-[22rem] space-y-1">
              <Badge variant={HEALTH_VARIANT[health.tone]}>{health.label}</Badge>
              {health.detail && (
                <p
                  className={
                    health.tone === "warning" || health.tone === "stopped"
                      ? "text-destructive flex items-start gap-1.5 text-xs"
                      : "text-muted-foreground text-xs"
                  }
                >
                  {(health.tone === "warning" || health.tone === "stopped") && (
                    <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                  )}
                  {health.detail}
                </p>
              )}
            </div>
          );
        },
        // Attention first, which is also the order the server sends. Sorted by
        // how loudly a row is asking for it rather than alphabetically by
        // label, so "Stopped on its own" cannot end up below "Running".
        sortValue: (entry) => describeHealth(entry).rank,
        firstSortDirection: "desc",
        filterValue: (entry) => describeHealth(entry).label,
      },
      {
        id: "produced",
        header: "Made",
        // The noun as well as the number: "12 episodes" reads on its own, and
        // on a phone this becomes a `<dd>` under the word "Made" where a bare
        // number would say nothing about what was made.
        cell: (entry) =>
          countOf(entry.produced, AUTOMATION_KINDS[entry.kind].producedNoun),
        sortValue: (entry) => entry.produced,
        firstSortDirection: "desc",
        cellClassName: "text-sm tabular-nums",
      },
      {
        id: "actions",
        header: "Actions",
        cell: (entry) => {
          const { Controls } = AUTOMATION_KINDS[entry.kind];

          return <Controls entry={entry} />;
        },
        align: "right",
        alwaysVisible: true,
      },
    ],
    [],
  );

  return (
    <DataTable
      rows={automations}
      columns={columns}
      getRowId={(entry) => entry.rowId}
      caption="Your automations"
      searchPlaceholder="Search automations"
      pageSize={25}
      columnToggle
      empty={empty}
    />
  );
}
