import type { Metadata } from "next";

import { PageHeader } from "@/components/shared/page-header";
import { Reveal } from "@/components/shared/reveal";
import { Badge } from "@/components/ui/badge";
import { PendingAccountList } from "@/features/auth/components/pending-account-list";
import { requireOperator } from "@/server/session";
import { accountService } from "@/services/account.service";

export const metadata: Metadata = { title: "Approvals" };

/**
 * The queue of accounts waiting to be let in.
 *
 * This page used to gate on `requireUser()`, and its comment used to say that
 * reaching that line already meant the viewer was an approved operator. That
 * was accurate while there was one account; once registration opened it
 * described the vulnerability rather than the design — every approved member
 * could read the queue of people waiting (their names and email addresses) and
 * decide on them.
 *
 * `requireOperator()` is the whole authorization story now, and it turns a
 * member away exactly as it turns away someone who is not signed in at all.
 * The two actions behind the buttons gate independently: this page is a
 * convenience, never the boundary.
 */
export default async function ApprovalsPage() {
  await requireOperator();

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
