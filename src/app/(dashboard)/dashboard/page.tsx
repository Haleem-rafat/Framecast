import type { Metadata } from "next";
import { Suspense } from "react";
import { Sparkles } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DashboardStats,
  DashboardStatsSkeleton,
} from "@/features/dashboard/components/dashboard-stats";
import { RecentActivityCard } from "@/features/dashboard/components/recent-activity-card";
import { RecentVideosCard } from "@/features/dashboard/components/recent-videos-card";
import {
  OnboardingChecklistCard,
  OnboardingChecklistCardSkeleton,
} from "@/features/onboarding/components/onboarding-checklist-card";
import { dashboardService } from "@/services/dashboard.service";
import { onboardingService } from "@/services/onboarding.service";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Dashboard" };

async function DashboardContent() {
  const user = await requireUser();
  const [{ stats, recentVideos, recentActivity }, checklist] =
    await Promise.all([
      dashboardService.getOverview(user.id),
      onboardingService.getChecklist(user.id),
    ]);

  return (
    <>
      <OnboardingChecklistCard checklist={checklist} />
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
      <OnboardingChecklistCardSkeleton />
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
          // /automation isn't built yet — disabled here for the same reason
          // it's disabled in the sidebar: don't link to a page that 404s.
          <Button disabled>
            <Sparkles />
            One-click generate
            <Badge variant="secondary" className="ml-1">
              Soon
            </Badge>
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
