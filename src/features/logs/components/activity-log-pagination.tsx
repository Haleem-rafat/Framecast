import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";

interface ActivityLogPaginationProps {
  page: number;
  pageCount: number;
  total: number;
  /** Current filter state, preserved across page moves. */
  query: { action?: string; level?: string };
}

function hrefFor(page: number, query: ActivityLogPaginationProps["query"]) {
  const params = new URLSearchParams();

  if (query.action) {
    params.set("action", query.action);
  }
  if (query.level) {
    params.set("level", query.level);
  }
  // Page 1 is the canonical URL — omitting the param keeps it shareable and
  // matches where the filter dropdowns navigate to.
  if (page > 1) {
    params.set("page", String(page));
  }

  const search = params.toString();
  return search ? `/logs?${search}` : "/logs";
}

/**
 * Plain links rather than a client component: paging is a server fetch, and
 * links give the operator working middle-click and browser history for free.
 * A disabled `<Button>` stands in at each end, since a link to a page that
 * does not exist is worse than one that cannot be clicked.
 */
export function ActivityLogPagination({
  page,
  pageCount,
  total,
  query,
}: ActivityLogPaginationProps) {
  if (pageCount <= 1) {
    return null;
  }

  return (
    <div className="flex items-center justify-between">
      <p className="text-muted-foreground text-sm">
        Page {page} of {pageCount} · {total} events
      </p>

      <div className="flex items-center gap-2">
        {page > 1 ? (
          <Button variant="outline" size="sm" asChild>
            <Link href={hrefFor(page - 1, query)}>
              <ChevronLeft />
              Newer
            </Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            <ChevronLeft />
            Newer
          </Button>
        )}

        {page < pageCount ? (
          <Button variant="outline" size="sm" asChild>
            <Link href={hrefFor(page + 1, query)}>
              Older
              <ChevronRight />
            </Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            Older
            <ChevronRight />
          </Button>
        )}
      </div>
    </div>
  );
}
