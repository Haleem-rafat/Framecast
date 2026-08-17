"use client";

import { Handle, Position } from "@xyflow/react";
import { Tv, Unlink } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { countOf } from "@/lib/automation-language";

/**
 * A channel, and the head of one branch.
 *
 * It has one source handle and no target handle, which is the whole of the
 * "channels do not connect to each other" rule expressed in the DOM rather than
 * only in `connectionOutcome`. Two enforcements of one rule sounds like
 * duplication and is not: the handle decides what can be *started*, the
 * function decides what a started drag may *land on*, and the function is the
 * one with the reasons in it.
 *
 * The totals are the branch's, not the channel's own YouTube figures. An
 * operator looking at this canvas is asking "what is this channel producing",
 * and the honest answer is the sum of what the automations under it have made —
 * the channel's real subscriber count lives on /channels and would be a
 * different and more impressive number that answers a different question.
 */
export interface ChannelNodeData {
  channelId: string | null;
  title: string;
  automationCount: number;
  produced: number;
  published: number;
  [key: string]: unknown;
}

export function ChannelNode({ data }: { data: ChannelNodeData }) {
  // The unrooted branch. Drawn as a real node rather than left as loose
  // automations, because "these publish nowhere" is a fact that deserves a
  // heading — and drawn in the warning colour because it is one.
  const unrooted = data.channelId === null;

  return (
    <div
      className={
        "w-64 rounded-xl border-2 bg-card p-4 shadow-sm transition-colors " +
        (unrooted ? "border-destructive/60" : "border-primary/60")
      }
    >
      <div className="flex items-start gap-3">
        <div
          className={
            "flex size-9 shrink-0 items-center justify-center rounded-lg " +
            (unrooted ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary")
          }
        >
          {unrooted ? <Unlink className="size-5" /> : <Tv className="size-5" />}
        </div>

        <div className="min-w-0 flex-1">
          {unrooted ? (
            <p className="truncate font-semibold">{data.title}</p>
          ) : (
            <Link
              href={`/channels/${data.channelId}`}
              className="block truncate font-semibold hover:underline"
            >
              {data.title}
            </Link>
          )}
          <p className="text-muted-foreground text-xs">
            {countOf(data.automationCount, "automation")}
          </p>
        </div>
      </div>

      {unrooted ? (
        <p className="text-destructive mt-3 text-xs">
          These publish nowhere until their project is given a channel.
        </p>
      ) : (
        <div className="mt-3 flex items-center gap-2">
          <Badge variant="secondary" className="tabular-nums">
            {data.produced} made
          </Badge>
          <Badge
            variant={data.published > 0 ? "default" : "secondary"}
            className="tabular-nums"
          >
            {data.published} published
          </Badge>
        </div>
      )}

      {/* No target handle: nothing is ever dropped *onto* a channel. */}
      <Handle
        type="source"
        position={Position.Right}
        className="!size-3 !border-2 !bg-background"
      />
    </div>
  );
}
