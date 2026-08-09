import type { Metadata } from "next";
import { Suspense } from "react";
import { Sparkles } from "lucide-react";
import Link from "next/link";

import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DashboardStats,
  DashboardStatsSkeleton,
} from "@/features/dashboard/components/dashboard-stats";
import { RecentActivityCard } from "@/features/dashboard/components/recent-activity-card";
import { RecentVideosCard } from "@/features/dashboard/components/recent-videos-card";
import { dashboardService } from "@/services/dashboard.service";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Dashboard" };

async function DashboardContent() {
  const user = await requireUser();
  const { stats, recentVideos, recentActivity } =
    await dashboardService.getOverview(user.id);

  return (
    <>
      <DashboardStats stats={stats} />
      <div className="grid gap-4 lg:grid-cols-3">
        <RecentVideosCard videos={recentVideos} />
        <RecentActivityCard items={recentActivity} />
      </div>
    </>
  );
}

function DashboardContentSkeleton() {
  return (
    <>
      <DashboardStatsSkeleton />
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-80 lg:col-span-2" />
        <Skeleton className="h-80" />
      </div>
    </>
  );
}

export default function DashboardPage() {
  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Everything moving through your production pipeline."
        actions={
          <Button asChild>
            <Link href="/automation">
              <Sparkles />
              One-click generate
            </Link>
          </Button>
        }
      />

      {/* The shell paints immediately; the data-dependent region streams in. */}
      <Suspense fallback={<DashboardContentSkeleton />}>
        <DashboardContent />
      </Suspense>
    </>
  );
}
