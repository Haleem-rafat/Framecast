import Link from "next/link";
import { AlertTriangle, ChevronRight, Clock, Layers } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ReleaseCadenceControls } from "@/features/automation/components/release-cadence-controls";
import type { ReleaseCadenceSummary } from "@/services/release.service";

/**
 * The drip, one row per channel.
 *
 * Four facts, and they are the four an operator running three channels checks
 * in the morning: is it running, when is the next clip, what is that clip, and
 * — the one that decides what they do today — how many days of cover is left in
 * the bank.
 *
 * An empty bank is drawn as information, not as an alarm. It is the normal
 * state of a channel whose long videos have not been cut into shorts yet, the
 * drip resumes by itself the moment they are, and painting it red would train
 * the operator to ignore the colour that means something is actually wrong.
 */
export function ReleaseCadenceList({
  cadences,
}: {
  cadences: ReleaseCadenceSummary[];
}) {
  return (
    <div className="space-y-3">
      {cadences.map((cadence) => (
        <Card key={cadence.id}>
          <CardContent className="flex flex-col gap-4 py-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href={`/automation/releases/${cadence.id}`}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {cadence.channelTitle}
                </Link>
                <Badge variant={cadence.status === "ACTIVE" ? "default" : "secondary"}>
                  {cadence.status === "ACTIVE" ? "Active" : "Paused"}
                </Badge>
                {cadence.visibility !== "PUBLIC" && (
                  <Badge variant="outline">{cadence.visibility.toLowerCase()}</Badge>
                )}
              </div>

              <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
                <Clock className="size-3.5 shrink-0" />
                {cadence.cadence}
              </p>

              {/* Only meaningful while active. Showing a next-release time on a
                  paused cadence would advertise a clip that is not coming. */}
              {cadence.status === "ACTIVE" && cadence.nextReleaseAt && (
                <p className="text-sm">
                  Next{" "}
                  <span className="font-medium" suppressHydrationWarning>
                    {cadence.nextReleaseAt.toLocaleString()}
                  </span>
                  {cadence.nextShortTitle && (
                    <>
                      {" — "}
                      <span className="text-muted-foreground">
                        {cadence.nextShortTitle}
                      </span>
                    </>
                  )}
                </p>
              )}

              {cadence.status === "PAUSED" && cadence.pausedReason && (
                <p className="text-muted-foreground flex items-start gap-1.5 text-sm">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  {cadence.pausedReason}
                </p>
              )}

              <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <Layers className="size-3.5 shrink-0" />
                {cadence.bankedCount === 0
                  ? "Nothing banked — the drip skips its slots until this channel has shorts ready"
                  : `${cadence.bankedCount} clip${cadence.bankedCount === 1 ? "" : "s"} banked` +
                    (cadence.daysOfCover > 0
                      ? ` — about ${cadence.daysOfCover} day${cadence.daysOfCover === 1 ? "" : "s"} of cover`
                      : " — less than a day of cover")}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <ReleaseCadenceControls
                cadenceId={cadence.id}
                channelTitle={cadence.channelTitle}
                status={cadence.status}
                compact
              />
              <Link
                href={`/automation/releases/${cadence.id}`}
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Open the drip on ${cadence.channelTitle}`}
              >
                <ChevronRight className="size-4" />
              </Link>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
