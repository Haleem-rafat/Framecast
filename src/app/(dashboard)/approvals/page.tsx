import type { Metadata } from "next";

import { PageHeader } from "@/components/shared/page-header";
import { Reveal } from "@/components/shared/reveal";
import { Badge } from "@/components/ui/badge";
import { PendingAccountList } from "@/features/auth/components/pending-account-list";
import { requireUser } from "@/server/session";
import { accountService } from "@/services/account.service";

export const metadata: Metadata = { title: "Approvals" };

/**
 * The queue of accounts waiting to be let in.
 *
 * `requireUser()` is the whole authorization story for this page: the approval
 * gate lives inside it, so reaching this line already means the viewer is an
 * approved operator. A pending account is redirected to /pending before the
 * queue is ever read, and the two actions behind the buttons check again on
 * the server anyway.
 */
export default async function ApprovalsPage() {
  await requireUser();

  const pending = await accountService.listPending();

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Accounts that have registered and cannot use the studio yet. Oldest first."
        actions={
          pending.length > 0 ? (
            <Badge variant="secondary">{pending.length} waiting</Badge>
          ) : undefined
        }
      />

      <Reveal>
        <PendingAccountList accounts={pending} />
      </Reveal>
    </>
  );
}
