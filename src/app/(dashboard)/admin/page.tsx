import type { Metadata } from "next";

import { PageHeader } from "@/components/shared/page-header";
import { Reveal } from "@/components/shared/reveal";
import { Badge } from "@/components/ui/badge";
import { AdminUserTable } from "@/features/admin/components/admin-user-table";
import { SystemTotals } from "@/features/admin/components/system-totals";
import { requireOperator } from "@/server/session";
import { adminService } from "@/services/admin.service";

export const metadata: Metadata = { title: "Admin" };

/**
 * Every account in the deployment, and the state of the box they share.
 *
 * `requireOperator()` is the gate, and it is the first statement in the
 * function for a reason: a member reaching this URL is redirected before a
 * single row is read, and gets exactly what a signed-out visitor gets (see the
 * helper's own comment for why an honest 403 would be worse than a redirect).
 *
 * The reads go through `adminService`, which shares no code path with the
 * per-user services the rest of the studio is built on — see its header. That
 * separation is the whole safety argument for this page: `videoService`,
 * `projectService` and the rest still filter by `userId` unconditionally and
 * were not touched, so "can a member see someone else's video" is still
 * answerable by reading them alone.
 *
 * The list read is itself audited. Every name and email in this table belongs
 * to somebody, so opening the page writes an `admin.users.list` row — see
 * `AdminService.recordListView`.
 */
export default async function AdminPage() {
  const operator = await requireOperator();

  const [totals, users] = await Promise.all([
    adminService.systemTotals(),
    adminService.listUsers(operator.id),
  ]);

  return (
    <>
      <PageHeader
        title="Admin"
        description="Every account in this deployment and the state of the machine they share. Read-only — the only decision an operator makes about an account is at Approvals."
        actions={
          totals.pendingCount > 0 ? (
            <Badge variant="secondary">{totals.pendingCount} waiting</Badge>
          ) : undefined
        }
      />

      <SystemTotals totals={totals} />

      <Reveal>
        <AdminUserTable users={users} />
      </Reveal>
    </>
  );
}
