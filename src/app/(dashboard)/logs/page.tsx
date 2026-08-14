import type { Metadata } from "next";

import { PageHeader } from "@/components/shared/page-header";
import {
  ActivityLogFilters,
  ALL,
} from "@/features/logs/components/activity-log-filters";
import { ActivityLogList } from "@/features/logs/components/activity-log-list";
import { ActivityLogPagination } from "@/features/logs/components/activity-log-pagination";
import type { LogLevel } from "@/generated/prisma/enums";
import { LogLevel as LogLevelValues } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Activity" };

/**
 * Large enough that a normal day of production fits on one page, small enough
 * that the page stays quick to render. The `[userId, createdAt]` index makes
 * the offset scan cheap at these depths.
 */
const PAGE_SIZE = 50;

const VALID_LEVELS = new Set<string>(Object.values(LogLevelValues));

interface LogsPageProps {
  searchParams: Promise<{ action?: string; level?: string; page?: string }>;
}

function parsePage(raw: string | undefined): number {
  const parsed = Number(raw);
  // Anything that isn't a positive integer — a negative, a float, `?page=abc`
  // — falls back to page 1 rather than producing a negative `skip`.
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

export default async function LogsPage({ searchParams }: LogsPageProps) {
  const user = await requireUser();
  const params = await searchParams;

  const levelFilter =
    params.level && VALID_LEVELS.has(params.level)
      ? (params.level as LogLevel)
      : undefined;
  // Any non-empty string is a legitimate action filter: services name actions
  // freely, so there is no fixed vocabulary to validate against. An action
  // nobody has logged simply matches nothing.
  const actionFilter = params.action?.trim() || undefined;

  // Scoped to this operator on every branch. `ActivityLog.userId` is nullable
  // (`onDelete: SetNull`), so orphaned rows from deleted accounts exist — and
  // an equality match on a concrete id excludes them, which is what we want.
  const where = {
    userId: user.id,
    ...(actionFilter ? { action: actionFilter } : {}),
    ...(levelFilter ? { level: levelFilter } : {}),
  };

  // Counted before paging so an out-of-range `?page=` can be clamped rather
  // than rendering a confusing empty table.
  const total = await prisma.activityLog.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(parsePage(params.page), pageCount);

  const [entries, actionGroups] = await Promise.all([
    prisma.activityLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      // `metadata` is intentionally not selected — see features/logs/types.ts.
      select: {
        id: true,
        level: true,
        action: true,
        message: true,
        entityType: true,
        entityId: true,
        createdAt: true,
      },
    }),
    // Options for the action dropdown. Deliberately ignores the level filter
    // so the list of actions doesn't shrink out from under the operator as
    // they narrow by level, but it does stay scoped to their own rows.
    prisma.activityLog.groupBy({
      by: ["action"],
      where: { userId: user.id },
      _count: { action: true },
      orderBy: { _count: { action: "desc" } },
    }),
  ]);

  const actions = actionGroups.map((group) => ({
    action: group.action,
    count: group._count.action,
  }));

  return (
    <>
      <PageHeader
        title="Activity"
        description="Everything the studio has recorded against your account, newest first."
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <ActivityLogFilters
          action={actionFilter ?? ALL}
          level={levelFilter ?? ALL}
          actions={actions}
        />
        <p className="text-muted-foreground text-sm">
          {total} {total === 1 ? "event" : "events"}
        </p>
      </div>

      <ActivityLogList
        entries={entries}
        hasFilter={Boolean(actionFilter ?? levelFilter)}
      />

      <ActivityLogPagination
        page={page}
        pageCount={pageCount}
        total={total}
        query={{ action: actionFilter, level: levelFilter }}
      />
    </>
  );
}
