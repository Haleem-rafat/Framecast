"use client";

import { Handle, Position } from "@xyflow/react";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import {
  countOf,
  describeHealth,
  describeNextRun,
  type AutomationHealthTone,
} from "@/lib/automation-language";
import { AUTOMATION_KINDS } from "@/features/automation/kinds";
import type { AutomationEntry } from "@/services/automation-list.service";

/**
 * One automation, as a card on the canvas.
 *
 * Everything that differs by kind — the icon, the badge label, the noun for
 * what is queued, the noun for what it has made — is read from
 * `AUTOMATION_KINDS`, exactly as the table does it. There is no `switch` on
 * `entry.kind` anywhere in this folder, and that is deliberate: the registry's
 * whole promise is that a fourth kind of automation is one new entry and no
 * redesign, and a canvas that quietly broke that promise would be worse than
 * the table it replaced.
 *
 * ## The headline pair
 *
 * `produced` and `published` sit together and large, because they are the
 * question the canvas was built to answer. "34 made" alone is a number an
 * operator can feel good about while nothing has reached an audience; the
 * second number is what makes the first one mean something.
 */

/** Same mapping the table uses, and repeated rather than exported from it
 *  because the table's is a private detail of a component the canvas does not
 *  otherwise depend on. If a third surface needs it, move it to
 *  automation-language.ts where the tones are defined. */
const HEALTH_VARIANT: Record<
  AutomationHealthTone,
  "default" | "secondary" | "destructive"
> = {
  healthy: "default",
  warning: "default",
  paused: "secondary",
  stopped: "destructive",
};

export interface AutomationNodeData {
  entry: AutomationEntry;
  [key: string]: unknown;
}

export function AutomationNode({ data }: { data: AutomationNodeData }) {
  const { entry } = data;
  const meta = AUTOMATION_KINDS[entry.kind];
  const health = describeHealth(entry);
  const Icon = meta.icon;

  return (
    <div className="w-72 rounded-xl border bg-card p-4 shadow-sm">
      <Handle
        type="target"
        position={Position.Left}
        className="!size-3 !border-2 !bg-background"
      />

      <div className="flex items-start gap-3">
        <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-lg">
          <Icon className="size-5" />
        </div>

        <div className="min-w-0 flex-1">
          <Link href={entry.href} className="block truncate font-semibold hover:underline">
            {entry.name}
          </Link>
          <p className="text-muted-foreground text-xs">{meta.label}</p>
        </div>

        <Badge variant={HEALTH_VARIANT[health.tone]} className="shrink-0">
          {health.label}
        </Badge>
      </div>

      {/* Only when there is something to say. A healthy automation's detail is
          reassurance nobody needs taking up a line on a canvas. */}
      {(health.tone === "warning" || health.tone === "stopped") && (
        <p className="text-muted-foreground mt-2 flex items-start gap-1.5 text-xs">
          <AlertTriangle className="text-destructive mt-0.5 size-3 shrink-0" />
          <span className="line-clamp-2">{health.detail}</span>
        </p>
      )}

      <p className="text-muted-foreground mt-3 text-xs">{entry.cadence}</p>

      {entry.nextRunAt && (
        <p className="text-muted-foreground text-xs">
          Next: {describeNextRun(entry.nextRunAt, entry.timeZone, new Date())}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* The pair this canvas exists to show. */}
        <Badge variant="secondary" className="tabular-nums">
          {entry.produced} made
        </Badge>
        <Badge
          variant={entry.published > 0 ? "default" : "secondary"}
          className="tabular-nums"
        >
          {entry.published} published
        </Badge>
      </div>

      {meta.backlogNoun && entry.backlog !== null && (
        <p
          className={
            "mt-2 text-xs " +
            // Zero is the number that matters: it is what makes the next
            // occurrence above a lie. Said in colour as well as words.
            (entry.backlog === 0 ? "text-destructive" : "text-muted-foreground")
          }
        >
          {entry.backlog === 0
            ? `No ${meta.backlogNoun}s left`
            : `${countOf(entry.backlog, meta.backlogNoun)} waiting`}
        </p>
      )}

      {entry.channelWarning && (
        <p className="text-destructive mt-2 line-clamp-2 text-xs">
          {entry.channelWarning}
        </p>
      )}

      {/* Only a kind that can publish itself gets an outgoing handle — the
          other half of `connectionOutcome`'s refusal for a shorts drip, said
          in the DOM so the drag cannot even start. */}
      {entry.autoPublish && (
        <Handle
          type="source"
          position={Position.Right}
          className="!size-3 !border-2 !bg-background"
        />
      )}
    </div>
  );
}
