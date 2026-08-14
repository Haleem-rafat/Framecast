"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Clapperboard, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { generateShortsAction, listShortsAction } from "@/actions/shorts.action";
import type { VideoStatus } from "@/generated/prisma/enums";
import { cn } from "@/lib/utils";
import type { ShortSummary } from "@/services/shorts.service";
import { formatDuration } from "@/utils/format";

/** Matches the pipeline panel's active cadence: a short encodes in seconds, so
 *  a slower poll would show "rendering" long after it finished. */
const POLL_INTERVAL_MS = 2000;

const STATUS_LABEL: Record<ShortSummary["status"], string> = {
  QUEUED: "Queued",
  RENDERING: "Rendering",
  READY: "Ready",
  FAILED: "Failed",
};

const STATUS_CLASS: Record<ShortSummary["status"], string> = {
  QUEUED: "text-muted-foreground",
  // amber-600 and emerald-600 both land near 3:1 on the card surface, which is
  // short of the 4.5:1 these badges need at this size. The 700 shades clear it
  // while reading as the same colour; the dark-mode 300s do the same job
  // against a dark card, where the 400s were the thin ones.
  RENDERING: "border-amber-700/30 text-amber-700 dark:border-amber-400/30 dark:text-amber-300",
  READY: "border-emerald-700/30 text-emerald-700 dark:border-emerald-400/30 dark:text-emerald-300",
  FAILED: "border-destructive/30 text-destructive",
};

function isSettled(shorts: ShortSummary[]): boolean {
  return shorts.every((short) => short.status === "READY" || short.status === "FAILED");
}

/**
 * One generated short. Playable as soon as the worker has written its file —
 * `preload="none"` so a panel showing three of them does not pull three clips
 * off disk on every page load, which on a 4GB box competes with the encode
 * that is very likely still running beside it.
 */
function ShortCard({ videoId, short }: { videoId: string; short: ShortSummary }) {
  return (
    <div className="flex gap-3 rounded-lg border p-3">
      <div className="w-28 shrink-0">
        {short.hasFile ? (
          <video
            className="aspect-[9/16] w-full rounded-md bg-black"
            src={`/api/videos/${videoId}/shorts/${short.id}/file`}
            controls
            preload="none"
          />
        ) : (
          <div className="bg-muted flex aspect-[9/16] w-full items-center justify-center rounded-md">
            {short.status === "FAILED" ? (
              <CircleAlert className="text-destructive size-5" />
            ) : (
              <Loader2 className="text-muted-foreground size-5 animate-spin" />
            )}
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium">{short.title ?? `Short ${short.index + 1}`}</p>
          <Badge variant="outline" className={cn("shrink-0 text-xs", STATUS_CLASS[short.status])}>
            {STATUS_LABEL[short.status]}
          </Badge>
        </div>

        <p className="text-muted-foreground text-xs">
          {formatDuration(short.startSeconds)}–{formatDuration(short.endSeconds)} ·{" "}
          {Math.round(short.endSeconds - short.startSeconds)}s
        </p>

        {short.reason && <p className="text-muted-foreground text-xs italic">{short.reason}</p>}

        {short.description && <p className="text-xs">{short.description}</p>}

        {short.status === "FAILED" && short.error && (
          <p className="text-destructive text-xs">{short.error}</p>
        )}
      </div>
    </div>
  );
}

/**
 * The shorts panel on the video detail page.
 *
 * Generation is two steps that this component deliberately keeps visible as
 * two: pressing the button asks a model to pick the moments and returns as soon
 * as it has (a second or two), leaving the shorts QUEUED; the worker then
 * encodes them one at a time and this poll watches them turn READY. Waiting for
 * the whole thing inside the action would hold a request open for three encodes.
 *
 * Nothing here publishes anything, and there is no button that could. Shorts
 * are drafts an operator reviews and uploads by hand — see the `ShortStatus`
 * comment in schema.prisma for why the status enum has no PUBLISHED member to
 * make that a rule rather than an omission.
 */
export function ShortsPanel({
  videoId,
  status,
  initialShorts,
}: {
  videoId: string;
  status: VideoStatus;
  initialShorts: ShortSummary[];
}) {
  const [isGenerating, setIsGenerating] = useState(false);

  const { data: shorts = initialShorts, refetch } = useQuery({
    queryKey: ["shorts", videoId],
    queryFn: async () => {
      const result = await listShortsAction(videoId);
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      return result.data;
    },
    initialData: initialShorts,
    // Polls only while something is actually in flight. A video whose shorts
    // are all READY is a page that never talks to the server again.
    refetchInterval: (query) => {
      const current = query.state.data ?? [];
      return current.length > 0 && !isSettled(current) ? POLL_INTERVAL_MS : false;
    },
  });

  // Shorts are cut out of a finished render, so there is nothing to offer
  // before one exists. PUBLISHED counts: publishing reclaims the section clips
  // but leaves the render itself, and a live video is exactly the one an
  // operator wants shorts from.
  const canGenerate = status === "READY" || status === "PUBLISHED";

  async function onGenerate() {
    setIsGenerating(true);

    const result = await generateShortsAction(videoId);

    setIsGenerating(false);

    if (!result.ok) {
      // The service's messages are already complete, specific sentences (a
      // script with no cues, a render no longer on disk), so they are shown
      // verbatim rather than replaced with a generic failure.
      toast.error("Could not generate shorts", { description: result.error.message });
      return;
    }

    toast.success(`Queued ${result.data.length} short${result.data.length === 1 ? "" : "s"}`, {
      description: "They render one at a time and appear here as they finish.",
    });
    await refetch();
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Clapperboard className="size-4" />
            Shorts
          </CardTitle>
          <p className="text-muted-foreground text-xs">
            Vertical clips cut from the best moments of this video. Drafts — review
            and upload them yourself.
          </p>
        </div>

        <Button
          size="sm"
          variant="outline"
          onClick={onGenerate}
          disabled={!canGenerate || isGenerating}
        >
          {isGenerating ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {shorts.length > 0 ? "Regenerate" : "Generate"}
        </Button>
      </CardHeader>

      <CardContent className="space-y-2">
        {!canGenerate ? (
          <p className="text-muted-foreground text-sm">
            Shorts are cut out of a finished video. Render this one first.
          </p>
        ) : shorts.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No shorts yet. Generate picks the moments worth clipping and queues them.
          </p>
        ) : (
          shorts.map((short) => (
            <ShortCard key={short.id} videoId={videoId} short={short} />
          ))
        )}

        {shorts.length > 0 && (
          <p className="text-muted-foreground pt-1 text-xs">
            Regenerating replaces this set and deletes their files.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
