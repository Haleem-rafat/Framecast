"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  generateShortsAction,
  listShortsAction,
} from "@/actions/shorts.action";
import { VideoSection } from "@/features/videos/components/video-section";
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
  RENDERING:
    "border-amber-700/30 text-amber-700 dark:border-amber-400/30 dark:text-amber-300",
  READY:
    "border-emerald-700/30 text-emerald-700 dark:border-emerald-400/30 dark:text-emerald-300",
  FAILED: "border-destructive/30 text-destructive",
};

function isSettled(shorts: ShortSummary[]): boolean {
  return shorts.every(
    (short) => short.status === "READY" || short.status === "FAILED",
  );
}

/**
 * One generated short. Playable as soon as the worker has written its file —
 * `preload="none"` so a panel showing three of them does not pull three clips
 * off disk on every page load, which on a 4GB box competes with the encode
 * that is very likely still running beside it.
 */
function ShortCard({
  videoId,
  short,
}: {
  videoId: string;
  short: ShortSummary;
}) {
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
          <p className="text-sm font-medium">
            {short.title ?? `Short ${short.index + 1}`}
          </p>
          <Badge
            variant="outline"
            className={cn("shrink-0 text-xs", STATUS_CLASS[short.status])}
          >
            {STATUS_LABEL[short.status]}
          </Badge>
        </div>

        <p className="text-muted-foreground text-xs">
          {formatDuration(short.startSeconds)}–
          {formatDuration(short.endSeconds)} ·{" "}
          {Math.round(short.endSeconds - short.startSeconds)}s
        </p>

        {short.reason && (
          <p className="text-muted-foreground text-xs italic">{short.reason}</p>
        )}

        {short.description && <p className="text-xs">{short.description}</p>}

        {short.status === "FAILED" && short.error && (
          <p className="text-destructive text-xs">{short.error}</p>
        )}
      </div>
    </div>
  );
}

/**
 * The one place `["shorts", videoId]` is fetched and polled.
 *
 * Exported so the section header (see `ShortsSummary`) can read the same list
 * without starting a second poll of its own: React Query keys one underlying
 * query and one scheduled refetch by `queryKey`, so two callers of this are
 * two observers of a single request. Written as a hook rather than duplicating
 * the options at the call site because the `refetchInterval` below is the part
 * that must not drift — a second copy that forgot to stop on `isSettled` would
 * poll a finished video forever.
 */
export function useShortsList(videoId: string, initialShorts: ShortSummary[]) {
  return useQuery({
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
      return current.length > 0 && !isSettled(current)
        ? POLL_INTERVAL_MS
        : false;
    },
  });
}

/**
 * What the shorts section says about itself while it is folded away, and
 * whether it should be folded at all.
 *
 * `rendering` is what stops a section quietly encoding three clips behind a
 * closed header — the page uses it to force this section open, the same way
 * the pipeline opens itself when a run starts.
 */
export function useShortsSummary(
  videoId: string,
  initialShorts: ShortSummary[],
): { label: string; rendering: boolean } {
  const { data: shorts = initialShorts } = useShortsList(
    videoId,
    initialShorts,
  );

  if (shorts.length === 0) {
    // Not blank: a collapsed header with nothing on the right is exactly the
    // header that makes folding a cost, because the only way to learn there is
    // nothing inside is to open it.
    return { label: "None yet", rendering: false };
  }

  const ready = shorts.filter((short) => short.status === "READY").length;
  const rendering = !isSettled(shorts);

  return {
    label: rendering
      ? `${ready} of ${shorts.length} ready`
      : `${shorts.length} short${shorts.length === 1 ? "" : "s"}`,
    rendering,
  };
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

  const { data: shorts = initialShorts, refetch } = useShortsList(
    videoId,
    initialShorts,
  );

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
      toast.error("Could not generate shorts", {
        description: result.error.message,
      });
      return;
    }

    toast.success(
      `Queued ${result.data.length} short${result.data.length === 1 ? "" : "s"}`,
      {
        description:
          "They render one at a time and appear here as they finish.",
      },
    );
    await refetch();
  }

  return (
    // No card of its own: every block on the video detail page is wrapped in
    // one collapsible `VideoSection`, which supplies the surface and the
    // "Shorts" heading. A card here would be a card inside a card under a
    // duplicated title.
    <div className="space-y-3">
      {/* Wraps rather than sitting on one row: at 375px the sentence and the
          button together are wider than the screen, and an unwrapped flex row
          would scroll the page sideways to reach the button. */}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="text-muted-foreground max-w-prose text-xs">
          Vertical clips cut from the best moments of this video. Drafts —
          review and upload them yourself.
        </p>

        <Button
          size="sm"
          variant="outline"
          onClick={onGenerate}
          disabled={!canGenerate || isGenerating}
        >
          {isGenerating ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {shorts.length > 0 ? "Regenerate" : "Generate"}
        </Button>
      </div>

      {!canGenerate ? (
        <p className="text-muted-foreground text-sm">
          Shorts are cut out of a finished video. Render this one first.
        </p>
      ) : shorts.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No shorts yet. Generate picks the moments worth clipping and queues
          them.
        </p>
      ) : (
        // A grid rather than a stack once there is room. Three shorts stacked
        // full-width was 800px of page for three 28px-wide thumbnails, which
        // is most of the dead space a finished video's page was carrying.
        <div className="grid gap-2 xl:grid-cols-2">
          {shorts.map((short) => (
            <ShortCard key={short.id} videoId={videoId} short={short} />
          ))}
        </div>
      )}

      {shorts.length > 0 && (
        <p className="text-muted-foreground text-xs">
          Regenerating replaces this set and deletes their files.
        </p>
      )}
    </div>
  );
}

/**
 * The shorts section, header and all.
 *
 * A client component rather than markup in the page because the header has to
 * be live: an operator who folds this away while three clips encode should
 * still see "1 of 3 ready" tick up, and `useShortsSummary` can only be called
 * from a client component. The page is a server component, and the panel
 * itself is *inside* the section it would need to describe — so, as with the
 * pipeline, the composition lives one level up from both.
 */
export function ShortsSection({
  videoId,
  status,
  initialShorts,
  defaultOpen,
}: {
  videoId: string;
  status: VideoStatus;
  initialShorts: ShortSummary[];
  defaultOpen: boolean;
}) {
  const { label, rendering } = useShortsSummary(videoId, initialShorts);

  return (
    <VideoSection
      id="shorts"
      title="Shorts"
      summary={label}
      defaultOpen={defaultOpen}
      active={rendering}
    >
      <ShortsPanel
        videoId={videoId}
        status={status}
        initialShorts={initialShorts}
      />
    </VideoSection>
  );
}
