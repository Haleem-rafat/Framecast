import {
  Clock,
  Film,
  HardDrive,
  TriangleAlert,
  Users,
  Video as VideoIcon,
} from "lucide-react";

import { StatCard } from "@/components/shared/stat-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes } from "@/features/admin/format";
import type { AdminSystemTotals } from "@/features/admin/types";
import { VideoStatusBadge } from "@/features/videos/components/video-status-badge";
import { VideoStatus } from "@/generated/prisma/enums";

/**
 * The psql session, as a page.
 *
 * These are the figures the owner currently gets by asking someone to run
 * queries against production: how many accounts, how many videos and in what
 * state, what the render worker is holding, what has failed, how much disk the
 * assets have taken. Nothing here is about an individual, which is why it
 * carries no audit row — there is no person whose data was read.
 *
 * The stalled count is the one worth explaining. A video whose lease expired
 * while it still says GENERATING or RENDERING is not being worked on: the
 * worker that held it died, and the row is claimable again but unclaimed. It
 * is the difference between "busy" and "wedged", and it is invisible in a
 * status breakdown, which is why it gets a card of its own.
 */
export function SystemTotals({ totals }: { totals: AdminSystemTotals }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard
          label="Accounts"
          value={String(totals.userCount)}
          icon={Users}
          hint={`${totals.operatorCount} operator${totals.operatorCount === 1 ? "" : "s"} · ${totals.pendingCount} waiting · ${totals.rejectedCount} rejected`}
        />
        <StatCard
          label="Videos"
          value={String(totals.videoCount)}
          icon={VideoIcon}
          hint={`Across ${totals.channelCount} connected channel${totals.channelCount === 1 ? "" : "s"}`}
        />
        <StatCard
          label="Renders in flight"
          value={String(totals.rendersInFlight)}
          icon={Clock}
          hint="Render jobs queued or running right now"
        />
        <StatCard
          label="Stalled videos"
          value={String(totals.stalledVideos)}
          icon={TriangleAlert}
          tone={totals.stalledVideos > 0 ? "danger" : "default"}
          hint="Lease lapsed mid-pipeline — the worker holding them died"
        />
        <StatCard
          label="Failed jobs"
          value={String(totals.failedRenders + totals.failedShorts)}
          icon={Film}
          tone={
            totals.failedRenders + totals.failedShorts > 0
              ? "danger"
              : "default"
          }
          hint={`${totals.failedRenders} render${totals.failedRenders === 1 ? "" : "s"} · ${totals.failedShorts} short${totals.failedShorts === 1 ? "" : "s"}`}
        />
        <StatCard
          label="Stored assets"
          value={formatBytes(totals.storageBytes)}
          icon={HardDrive}
          hint="Sum of every asset's recorded size, deployment-wide"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Videos by status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-wrap gap-2">
            {/* Iterating the enum rather than the query result, so a status
             * with no videos still appears as a zero. A breakdown that
             * silently omits FAILED when nothing has failed reads the same as
             * one that forgot to include it. */}
            {Object.values(VideoStatus).map((status) => {
              const count =
                totals.videosByStatus.find((row) => row.status === status)
                  ?.count ?? 0;

              return (
                <li key={status} className="flex items-center gap-1.5">
                  <VideoStatusBadge status={status} />
                  <Badge variant="secondary" className="font-mono">
                    {count}
                  </Badge>
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
