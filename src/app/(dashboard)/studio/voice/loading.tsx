import {
  DataTableSkeleton,
  FootnoteSkeleton,
  LoadingAnnouncement,
  PageHeaderSkeleton,
} from "@/components/shared/skeletons";
import { StatCardSkeleton } from "@/components/shared/stat-card";

/**
 * Three stat cards over the narration table.
 *
 * The third stat card is the ElevenLabs allowance, which the page already
 * streams behind its own `<Suspense fallback={<StatCardSkeleton />}>` — so once
 * this route-level fallback clears, that one card keeps its place while the
 * network call finishes. The two skeletons agree on shape because they are the
 * same component, which is what makes the handover invisible.
 */
export default function VoiceStudioLoading() {
  return (
    <>
      <LoadingAnnouncement>Loading narrations…</LoadingAnnouncement>

      <PageHeaderSkeleton titleWidth="w-24" descriptionWidth="w-full max-w-2xl" />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <StatCardSkeleton key={index} />
        ))}
      </div>

      <div className="space-y-4">
        <DataTableSkeleton rows={6} columns={6} hasColumnToggle />
      </div>

      <FootnoteSkeleton lines={4} />
    </>
  );
}
