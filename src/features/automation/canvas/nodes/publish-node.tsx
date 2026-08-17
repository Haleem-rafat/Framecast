"use client";

import { Position } from "@xyflow/react";
import { Globe, Lock, Link2Off, Upload } from "lucide-react";

import { CanvasHandle } from "@/features/automation/canvas/nodes/canvas-handle";
import { Badge } from "@/components/ui/badge";
import type { PublishVisibility } from "@/generated/prisma/enums";

/**
 * The publish step at the end of an automation's branch.
 *
 * Not a record of anything — there is no publish-step table. It is a facet of
 * the automation drawn as a node, because "does this show upload itself, and as
 * what" is a stage of the pipeline in the operator's head even though it is two
 * columns in the database. Drawing it as a node is what makes it something you
 * can wire up, which is the whole reason the canvas is editable.
 *
 * Its id is its automation's id — see `CanvasNodeRef.id`. That pairing is what
 * lets `connectionOutcome` refuse a drag from one show to another show's
 * publish step, which would otherwise switch on unattended publishing for a
 * channel nobody was pointing at.
 *
 * ## Off is drawn, not hidden
 *
 * A switched-off publish step is dashed and grey rather than absent. An absent
 * node says "this automation cannot publish"; a dashed one says "it could, and
 * it is not" — and the second is the one an operator can act on. Only a shorts
 * drip, which publishes by definition, gets no node at all.
 */

const VISIBILITY_ICON: Record<PublishVisibility, typeof Globe> = {
  PUBLIC: Globe,
  UNLISTED: Link2Off,
  PRIVATE: Lock,
};

const VISIBILITY_LABEL: Record<PublishVisibility, string> = {
  PUBLIC: "Public",
  UNLISTED: "Unlisted",
  PRIVATE: "Private",
};

export interface PublishNodeData {
  /** The automation's id, deliberately — see this file's doc comment. */
  automationId: string;
  automationName: string;
  enabled: boolean;
  visibility: PublishVisibility;
  [key: string]: unknown;
}

export function PublishNode({ data }: { data: PublishNodeData }) {
  const Icon = VISIBILITY_ICON[data.visibility];

  return (
    <div
      className={
        "w-56 rounded-xl border-2 p-3 shadow-sm transition-colors " +
        (data.enabled
          ? "border-primary/60 bg-card"
          : "border-dashed border-muted-foreground/40 bg-muted/30")
      }
    >
      <CanvasHandle type="target" position={Position.Left} />

      <div className="flex items-center gap-2.5">
        <div
          className={
            "flex size-8 shrink-0 items-center justify-center rounded-lg " +
            (data.enabled
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground")
          }
        >
          <Upload className="size-4" />
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {data.enabled ? "Publishes itself" : "Publish is off"}
          </p>
          <p className="text-muted-foreground text-xs">
            {data.enabled ? "as soon as it renders" : "you publish by hand"}
          </p>
        </div>
      </div>

      {data.enabled && (
        <Badge variant="secondary" className="mt-2 gap-1">
          <Icon className="size-3" />
          {VISIBILITY_LABEL[data.visibility]}
        </Badge>
      )}
    </div>
  );
}
