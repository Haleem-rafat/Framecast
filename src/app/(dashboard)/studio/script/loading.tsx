import {
  DataTableSkeleton,
  FootnoteSkeleton,
  LoadingAnnouncement,
  PageHeaderSkeleton,
} from "@/components/shared/skeletons";
import { StatCardSkeleton } from "@/components/shared/stat-card";

/**
 * The script library's table is nine columns wide — the widest in the app — so
 * the generic fallback's single full-width bar per row was the least
 * representative shape on the dashboard.
 */
export default function ScriptLibraryLoading() {
  return (
    <>
      <LoadingAnnouncement>Loading the script library…</LoadingAnnouncement>

      {/* This page's description is long enough to wrap on a narrow window, so
       * the skeleton reserves two lines rather than one. */}
      <PageHeaderSkeleton titleWidth="w-40" descriptionWidth="w-full max-w-2xl" />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <StatCardSkeleton key={index} />
        ))}
      </div>

      <DataTableSkeleton rows={6} columns={9} hasColumnToggle />

      <FootnoteSkeleton lines={4} />
    </>
  );
}
