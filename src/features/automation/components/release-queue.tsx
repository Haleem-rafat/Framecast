import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { ReleaseQueueEntry } from "@/services/release.service";

/**
 * What is banked, in the order it goes out, and when each one is due.
 *
 * The pairing of clip to slot is the whole point. A list of banked clips
 * answers "what have I got"; a list that says *when each one goes out* answers
 * "is Thursday covered", which is the question an operator opens this page
 * with. It is a projection rather than a promise — a video finished tomorrow
 * adds clips behind these, and a slot that finds a missing file pulls
 * everything one place forward — and it is exactly right for the queue as it
 * stands now, which is what a projection is for.
 *
 * A server component: this is a read of rows the page already has, and none of
 * it is interactive.
 */
export function ReleaseQueue({
  entries,
  bankedCount,
  daysOfCover,
  slotsPerDay,
}: {
  entries: ReleaseQueueEntry[];
  bankedCount: number;
  daysOfCover: number;
  slotsPerDay: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Banked clips</CardTitle>
        <CardDescription>
          Rendered shorts on this channel that have not been published yet,
          oldest video first and in play order within it. The drip takes them
          from the top, one per slot.
          {bankedCount > entries.length && (
            <> Showing the next {entries.length} of {bankedCount}.</>
          )}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {entries.length === 0 ? (
          <>
            {/* The empty queue, stated as the ordinary thing it is. An operator
                who finds no clip went out this morning needs to be told the
                difference between "nothing was banked" and "something broke",
                and this is the first place they will look. */}
            <p className="text-muted-foreground rounded-md border border-dashed px-3 py-6 text-center text-sm">
              Nothing banked. Every slot will be recorded as skipped until this
              channel has rendered shorts waiting — the drip is not broken and
              does not need resuming, it starts again by itself as soon as a
              video is cut into clips.
            </p>
            <p className="text-muted-foreground text-xs">
              Shorts are cut on a finished video&apos;s own page. Three long
              videos a week yield roughly twenty-one clips, which is what{" "}
              {slotsPerDay} a day spends.
            </p>
          </>
        ) : (
          <>
            <p className="text-muted-foreground text-xs">
              {bankedCount} banked at {slotsPerDay} a day —{" "}
              <span className="text-foreground font-medium">
                {daysOfCover > 0
                  ? `about ${daysOfCover} day${daysOfCover === 1 ? "" : "s"} of cover`
                  : "less than a day of cover"}
              </span>
              .
            </p>

            <ul className="divide-border divide-y text-sm">
              {entries.map((entry, position) => (
                <li
                  key={entry.shortId}
                  className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {position === 0 && <Badge>Next</Badge>}
                      <span className="font-medium">
                        {entry.title ?? `Short ${entry.index + 1}`}
                      </span>
                    </div>
                    <p className="text-muted-foreground text-xs">
                      Clip {entry.index + 1} of{" "}
                      <Link
                        href={`/videos/${entry.videoId}`}
                        className="underline-offset-4 hover:underline"
                      >
                        {entry.videoTitle}
                      </Link>
                    </p>
                  </div>

                  {entry.releasesAt ? (
                    <time
                      dateTime={entry.releasesAt.toISOString()}
                      className="text-muted-foreground shrink-0 text-xs"
                      suppressHydrationWarning
                    >
                      {entry.releasesAt.toLocaleString()}
                    </time>
                  ) : (
                    <span className="text-muted-foreground shrink-0 text-xs">
                      No slot while paused
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
