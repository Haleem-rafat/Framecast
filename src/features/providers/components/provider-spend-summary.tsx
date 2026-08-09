import { Wallet } from "lucide-react";

import { EmptyState } from "@/components/shared/empty-state";
import { StatCard } from "@/components/shared/stat-card";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PROVIDER_LABELS } from "@/features/providers/provider-labels";
import type { AiProviderType } from "@/generated/prisma/enums";
import { formatCurrency } from "@/utils/format";

export interface ProviderSpend {
  provider: AiProviderType;
  costUsd: number;
}

export function ProviderSpendSummary({ spend }: { spend: ProviderSpend[] }) {
  const total = spend.reduce((sum, one) => sum + one.costUsd, 0);

  return (
    <div className="space-y-4">
      <StatCard
        label="Spend (last 30 days)"
        value={formatCurrency(total)}
        icon={Wallet}
        hint="Deployment-wide across every provider — not scoped per operator"
      />

      {spend.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">By provider</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {spend.map((one) => (
              <div
                key={one.provider}
                className="flex items-center justify-between text-sm"
              >
                <span className="text-muted-foreground">
                  {PROVIDER_LABELS[one.provider]}
                </span>
                <span className="font-mono">
                  {formatCurrency(one.costUsd)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {spend.length === 0 && (
        <EmptyState
          icon={Wallet}
          title="No spend yet"
          description="Generation costs will show up here once a provider has been used in the last 30 days."
        />
      )}
    </div>
  );
}
