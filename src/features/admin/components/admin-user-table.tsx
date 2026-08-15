"use client";

import { useMemo } from "react";
import Link from "next/link";

import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { RelativeTime } from "@/components/shared/relative-time";
import {
  ApprovalBadge,
  RoleBadge,
} from "@/features/admin/components/account-badges";
import type { AdminUserSummary } from "@/features/admin/types";

/**
 * Every account in the deployment.
 *
 * ## No selection column
 *
 * `DataTable` offers multi-select, and this is the table it would most
 * obviously be used on. It is deliberately not used, because
 * `DataTableSelection` requires an `actions` renderer — by construction, that
 * component has no half-configured state where rows can be ticked and nothing
 * can be done with them — and there is nothing to do. /admin is read-only:
 * the only cross-user write in the product is approve/reject, which has its
 * own queue at /approvals where the rows are the ones actually waiting.
 * Checkboxes here would be an affordance leading nowhere.
 *
 * Sorting, search and the mobile card layout are all used, and they are what
 * the page needs: "who joined last week", "who has never done anything",
 * "who has forty videos".
 */
export function AdminUserTable({ users }: { users: AdminUserSummary[] }) {
  const columns = useMemo<DataTableColumn<AdminUserSummary>[]>(
    () => [
      {
        id: "account",
        header: "Account",
        cell: (row) => (
          <Link
            href={`/admin/users/${row.id}`}
            className="hover:text-primary block min-w-0 underline-offset-4 hover:underline"
          >
            <span className="block truncate font-medium">{row.name}</span>
            <span className="text-muted-foreground block truncate text-xs">
              {row.email}
            </span>
          </Link>
        ),
        sortValue: (row) => row.email,
        filterValue: (row) => `${row.name} ${row.email}`,
        alwaysVisible: true,
      },
      {
        id: "approval",
        header: "Approval",
        cell: (row) => <ApprovalBadge approval={row.approval} />,
        sortValue: (row) => row.approval,
        filterValue: (row) => row.approval,
      },
      {
        id: "role",
        header: "Role",
        cell: (row) => <RoleBadge role={row.role} />,
        // Operators first: on a roster where almost every row is a member,
        // the privileged ones are what the column is being sorted for.
        sortValue: (row) => row.role,
        filterValue: (row) => row.role,
      },
      {
        id: "joined",
        header: "Joined",
        cell: (row) => <RelativeTime date={row.createdAt} />,
        sortValue: (row) => row.createdAt,
        firstSortDirection: "desc",
      },
      {
        id: "projects",
        header: "Projects",
        cell: (row) => <span className="font-mono">{row.projectCount}</span>,
        sortValue: (row) => row.projectCount,
        firstSortDirection: "desc",
        align: "right",
      },
      {
        id: "videos",
        header: "Videos",
        cell: (row) => <span className="font-mono">{row.videoCount}</span>,
        sortValue: (row) => row.videoCount,
        firstSortDirection: "desc",
        align: "right",
      },
      {
        id: "channels",
        header: "Channels",
        cell: (row) => <span className="font-mono">{row.channelCount}</span>,
        sortValue: (row) => row.channelCount,
        firstSortDirection: "desc",
        align: "right",
      },
      {
        id: "lastActive",
        header: "Last active",
        cell: (row) =>
          row.lastActiveAt ? (
            <RelativeTime date={row.lastActiveAt} />
          ) : (
            // An account that registered and never did anything is a real
            // category — a bot, an abandoned sign-up — and worth naming rather
            // than showing as an em dash beside forty real timestamps.
            <span className="text-muted-foreground text-sm">Never</span>
          ),
        // `sortRows` sinks null keys to the bottom in both directions, so the
        // never-active rows stay out of the way of the recency question.
        sortValue: (row) => row.lastActiveAt,
        firstSortDirection: "desc",
      },
    ],
    [],
  );

  return (
    <DataTable
      rows={users}
      columns={columns}
      getRowId={(row) => row.id}
      caption="Every account in this deployment, newest registration first"
      searchPlaceholder="Search by name or email"
      columnToggle
      pageSize={25}
    />
  );
}
