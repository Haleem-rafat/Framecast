import {
  DataTableSkeleton,
  LoadingAnnouncement,
  PageHeaderSkeleton,
} from "@/components/shared/skeletons";

/**
 * `AutomationTable` is a `DataTable`: a search-and-columns toolbar above a real
 * table on `md` and up, stacked cards below it. The generic dashboard fallback
 * draws neither, so without this the route jumped twice — once as the toolbar
 * pushed the rows down, and again on a phone as the bars became cards.
 *
 * Seven columns: name, channel, project, next run, status, made, actions. No
 * checkbox column — this table has no bulk actions, because pausing nine
 * automations at once is not a thing an operator does deliberately.
 */
export default function AutomationLoading() {
  return (
    <>
      <LoadingAnnouncement>Loading your automations…</LoadingAnnouncement>

      <PageHeaderSkeleton
        titleWidth="w-40"
        descriptionWidth="w-96"
        actionWidth="w-64"
      />

      <DataTableSkeleton rows={6} columns={7} hasColumnToggle />
    </>
  );
}
