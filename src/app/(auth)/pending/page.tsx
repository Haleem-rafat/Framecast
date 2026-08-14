import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Hourglass, ShieldX } from "lucide-react";

import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AuthCard } from "@/features/auth/components/auth-card";
import { AuthShell } from "@/features/auth/components/auth-shell";
import { PendingAccountActions } from "@/features/auth/components/pending-account-actions";
import { getAccountStatus } from "@/server/session";

export const metadata: Metadata = { title: "Waiting for approval" };

/**
 * Where the approval gate sends a signed-in account that may not use the
 * studio. Lives under (auth) rather than (dashboard) on purpose: the dashboard
 * layout calls `requireUser()`, which redirects here, so hosting this page
 * inside it would be an infinite redirect.
 */
export default async function PendingPage() {
  const status = await getAccountStatus();

  if (!status) {
    redirect("/sign-in");
  }

  // The whole point of the page is gone once the account is cleared, and an
  // operator who has just been approved should not have to find their own way.
  if (status.approval === "APPROVED") {
    redirect("/dashboard");
  }

  const isRejected = status.approval !== "PENDING";

  return (
    <AuthShell
      subtitle={`Signed in as ${status.user.email}`}
      footer={
        isRejected
          ? "If you think this is a mistake, ask the studio owner to look again."
          : "Approvals are done by hand, so this can take a little while."
      }
    >
      <AuthCard>
        <CardHeader>
          <div className="bg-muted text-muted-foreground mb-1 flex size-10 items-center justify-center rounded-full">
            {isRejected ? (
              <ShieldX className="size-5" />
            ) : (
              <Hourglass className="size-5" />
            )}
          </div>
          <CardTitle>
            {isRejected
              ? "This account was not approved"
              : "Your account is waiting for approval"}
          </CardTitle>
          <CardDescription>
            {isRejected
              ? "An operator reviewed this account and declined it. Nothing in the studio is reachable from here."
              : "Your account exists, but an existing operator has to approve it before it can open the studio. Nothing has been lost — sign in again any time to check."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PendingAccountActions />
        </CardContent>
      </AuthCard>
    </AuthShell>
  );
}
