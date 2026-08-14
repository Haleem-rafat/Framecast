import { UserCheck } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { RelativeTime } from "@/components/shared/relative-time";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { ApprovalDecisionButtons } from "@/features/auth/components/approval-decision-buttons";
import type { PendingAccount } from "@/services/account.service";
import { getInitials } from "@/utils/format";

export function PendingAccountList({
  accounts,
}: {
  accounts: PendingAccount[];
}) {
  if (accounts.length === 0) {
    return (
      <EmptyState
        icon={UserCheck}
        title="Nobody is waiting"
        description="New registrations land here. Until someone signs up, there is nothing to decide."
      />
    );
  }

  return (
    <div className="space-y-3">
      {accounts.map((account) => (
        <Card key={account.id}>
          <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <Avatar className="size-9">
                <AvatarImage
                  src={account.image ?? undefined}
                  alt={account.name}
                />
                <AvatarFallback>{getInitials(account.name)}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 space-y-0.5">
                <p className="truncate font-medium">{account.name}</p>
                <p className="text-muted-foreground truncate text-sm">
                  {account.email}
                </p>
                <p className="text-muted-foreground text-xs">
                  Registered{" "}
                  <RelativeTime date={account.createdAt} />
                </p>
              </div>
            </div>

            <ApprovalDecisionButtons
              userId={account.id}
              email={account.email}
            />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
