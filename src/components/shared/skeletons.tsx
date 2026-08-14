import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * The pieces every dashboard `loading.tsx` is assembled from.
 *
 * These exist because a skeleton is only worth rendering if it is the same
 * shape as what replaces it. Hand-rolling that shape eleven times guarantees
 * eleven slightly different guesses about how tall a table row is, and each
 * wrong guess is a layout jump at the exact moment the operator starts
 * reading. Naming the shapes once means a change to `DataTable` or
 * `PageHeader` has one place to be mirrored.
 *
 * All server components: no hook, no `"use client"`. A loading boundary that
 * needed JavaScript to appear would defeat its own purpose (see the note on
 * reduced motion in `src/components/ui/skeleton.tsx`).
 */

/**
 * The one-line announcement that makes a wait audible.
 *
 * A `Skeleton` is an empty `<div>`, so a page made of them is not "loading" to
 * a screen reader — it is nothing at all, on a route whose `<h1>` has not
 * arrived either. Rendering this as part of the fallback is what makes a
 * polite live region fire, so the wait is stated once rather than passed over
 * in silence.
 *
 * Always a direct child of the page fragment, never wrapped: `main` in the
 * dashboard layout is a `flex flex-col gap-6` whose gap a wrapper would
 * collapse, and `display: contents` — the usual dodge — has a history of
 * dropping elements out of the accessibility tree, which would remove the very
 * announcement being made.
 */
export function LoadingAnnouncement({ children }: { children: string }) {
  return (
    <span role="status" className="sr-only">
      {children}
    </span>
  );
}

/**
 * Mirrors `src/components/shared/page-header.tsx`: an `h1` (`text-2xl` ≈ 32px)
 * over an optional `text-sm` description, with actions pushed to the right on
 * `sm` and up. Widths are per-route because the real titles differ — a "Videos"
 * header and a "Prompt Library" header are not the same width, and a skeleton
 * that claims they are shifts sideways when the text lands.
 */
export function PageHeaderSkeleton({
  titleWidth = "w-40",
  descriptionWidth = "w-80",
  actionWidth,
}: {
  titleWidth?: string;
  descriptionWidth?: string;
  /** Omit when the real header renders no action button. */
  actionWidth?: string;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      {/* `space-y-1`, matching PageHeader's own inner stack. */}
      <div className="space-y-1">
        <Skeleton className={cn("h-8", titleWidth)} />
        <Skeleton className={cn("h-4", descriptionWidth)} />
      </div>
      {actionWidth && <Skeleton className={cn("h-9", actionWidth)} />}
    </div>
  );
}

/**
 * Mirrors `DataTable`: a toolbar, a `md`-and-up table, and the stacked cards it
 * swaps to below `md`.
 *
 * Both breakpoints are rendered with the same `hidden md:block` / `md:hidden`
 * pair the real component uses, rather than picking one. A phone shown a
 * desktop table skeleton gets a full-width jump to cards the moment data
 * arrives — which is the failure this is supposed to prevent, just on the
 * viewport nobody tested.
 */
export function DataTableSkeleton({
  rows = 6,
  columns = 5,
  hasColumnToggle = false,
}: {
  rows?: number;
  columns?: number;
  /** True for the tables that render the "Columns" button on the right. */
  hasColumnToggle?: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-9 w-full max-w-xs" />
        {hasColumnToggle && <Skeleton className="ml-auto h-8 w-24" />}
      </div>

      <div className="hidden md:block">
        {/* The header row is shorter than a body row in the real table, and
         * getting that wrong offsets every row below it by a few pixels. */}
        <div className="flex items-center gap-4 border-b py-2">
          {Array.from({ length: columns }, (_, index) => (
            <Skeleton key={index} className="h-4 flex-1" />
          ))}
        </div>
        <div className="divide-y">
          {Array.from({ length: rows }, (_, index) => (
            <div key={index} className="flex items-center gap-4 py-3">
              {Array.from({ length: columns }, (_, column) => (
                <Skeleton key={column} className="h-5 flex-1" />
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-3 md:hidden">
        {Array.from({ length: Math.min(rows, 4) }, (_, index) => (
          <Skeleton key={index} className="h-28 w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}

/** A `grid` of `Card`s, for the routes that list content as cards. */
export function CardGridSkeleton({
  count,
  className,
  children,
}: {
  count: number;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      {Array.from({ length: count }, (_, index) => (
        <div key={index}>{children}</div>
      ))}
    </div>
  );
}

/**
 * The `h2 + description` block that introduces a section on the pages built
 * from several stacked sections (publishing, analytics).
 */
export function SectionHeadingSkeleton({ width = "w-44" }: { width?: string }) {
  return <Skeleton className={cn("h-6", width)} />;
}

/**
 * The `text-xs text-balance` footnote several studio pages end with. Lines
 * shorten towards the end because balanced text does, and a block of
 * equal-width bars reads as a table rather than a paragraph.
 */
export function FootnoteSkeleton({ lines = 3 }: { lines?: number }) {
  const widths = ["w-full", "w-11/12", "w-4/5", "w-2/3", "w-1/2"];

  return (
    <div className="space-y-1.5">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={cn("h-3", widths[index % widths.length])} />
      ))}
    </div>
  );
}

/**
 * A generic content `Card` with a header and a body of text lines — the shape
 * behind the analytics/publishing summary cards.
 */
export function ContentCardSkeleton({
  bodyLines = 4,
  headingWidth = "w-40",
}: {
  bodyLines?: number;
  headingWidth?: string;
}) {
  return (
    <Card>
      <CardHeader className="space-y-2">
        <Skeleton className={cn("h-5", headingWidth)} />
        <Skeleton className="h-3 w-56" />
      </CardHeader>
      <CardContent className="space-y-3">
        {Array.from({ length: bodyLines }, (_, index) => (
          <div key={index} className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-4">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3.5 w-12" />
            </div>
            {/* The bar every BarList row draws under its label. */}
            <Skeleton className="h-2 w-full rounded-sm" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
