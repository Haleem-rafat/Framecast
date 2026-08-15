import {
  DataTableSkeleton,
  LoadingAnnouncement,
  PageHeaderSkeleton,
} from "@/components/shared/skeletons";

/**
 * `ProjectTable` is a `DataTable`: a search toolbar above a table on `md` and
 * up, and stacked cards below it. The generic dashboard fallback draws neither
 * the toolbar nor the mobile cards, so this route jumped twice — once as the
 * toolbar pushed the rows down, and again on a phone as the bars became cards.
 *
 * Seven columns: the checkbox, then name, channel, status, videos, updated and
 * actions. The selection bar is not drawn, because it only exists once the
 * operator has ticked something and nothing is ticked on a first paint.
 *
 * No column toggle: `ProjectTable` doesn't enable one, so drawing its button
 * would reserve space for a control that never arrives.
 */
export default function ProjectsLoading() {
  return (
    <>
      <LoadingAnnouncement>Loading projects…</LoadingAnnouncement>

      <PageHeaderSkeleton
        titleWidth="w-32"
        descriptionWidth="w-80"
        actionWidth="w-32"
      />

      <DataTableSkeleton rows={6} columns={7} />
    </>
  );
}
