import {
  CalendarClock,
  CircleAlert,
  Clapperboard,
  MonitorPlay,
} from "lucide-react";

import { StatCard, StatCardSkeleton } from "@/components/shared/stat-card";
import type { DashboardStats as DashboardStatsData } from "@/features/dashboard/types";

const GRID_CLASS = "grid gap-4 sm:grid-cols-2 lg:grid-cols-4";

export function DashboardStats({ stats }: { stats: DashboardStatsData }) {
  return (
    <div className={GRID_CLASS}>
      <StatCard
        label="Created today"
        value={String(stats.todayCount)}
        icon={Clapperboard}
        hint="Videos started in the last 24 hours"
      />
      <StatCard
        label="Scheduled"
        value={String(stats.scheduledCount)}
        icon={CalendarClock}
        hint="Queued for a future publish slot"
      />
      <StatCard
        label="Published"
        value={String(stats.publishedCount)}
        icon={MonitorPlay}
        hint="Live on YouTube"
        tone="success"
      />
      <StatCard
        label="Failed"
        value={String(stats.failedCount)}
        icon={CircleAlert}
        hint="Need attention"
        tone={stats.failedCount > 0 ? "danger" : "default"}
      />
    </div>
  );
}

export function DashboardStatsSkeleton() {
  return (
    <div className={GRID_CLASS}>
      {Array.from({ length: 4 }, (_, index) => (
        <StatCardSkeleton key={index} />
      ))}
    </div>
  );
}
