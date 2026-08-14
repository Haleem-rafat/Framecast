import type { Metadata } from "next";
import { subDays } from "date-fns";

import { PageHeader } from "@/components/shared/page-header";
import { Reveal } from "@/components/shared/reveal";
import { EnvironmentProviderTable } from "@/features/providers/components/environment-provider-table";
import { ProviderSpendSummary } from "@/features/providers/components/provider-spend-summary";
import { ProviderTable } from "@/features/providers/components/provider-table";
import { getEnvironmentProviderStatuses } from "@/features/providers/environment-providers";
import { prisma } from "@/lib/prisma";
import { providerCredentialService } from "@/services/provider-credential.service";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "AI Providers" };

const SPEND_WINDOW_DAYS = 30;

export default async function ProvidersPage() {
  const user = await requireUser();

  const [credentials, spendByProvider] = await Promise.all([
    providerCredentialService.list(user.id),
    // ProviderUsage carries no userId of its own (see script.service.ts) —
    // usage is deployment-wide, matching the single-operator shape of this app.
    prisma.providerUsage.groupBy({
      by: ["provider"],
      where: { createdAt: { gte: subDays(new Date(), SPEND_WINDOW_DAYS) } },
      _sum: { costUsd: true },
    }),
  ]);

  const spend = spendByProvider
    .map((row) => ({
      provider: row.provider,
      costUsd: Number(row._sum.costUsd ?? 0),
    }))
    .filter((row) => row.costUsd > 0)
    .sort((a, b) => b.costUsd - a.costUsd);

  return (
    <>
      <PageHeader
        title="AI Providers"
        description="API keys used to generate scripts, voice, thumbnails, and scenes."
      />

      <div className="space-y-2">
        <p className="text-muted-foreground text-sm">
          Per-operator API keys, stored encrypted and managed from this page.
        </p>
        <ProviderTable credentials={credentials} />
      </div>

      {/* The operator's own keys, above, are what this page is for and are left
       * alone. These two are reference material further down the page. */}
      <Reveal className="space-y-2">
        <p className="text-muted-foreground text-sm">
          Platform-level services configured via the deployment environment —
          read-only here; change them where the deployment&apos;s environment
          variables are set.
        </p>
        <EnvironmentProviderTable
          statuses={getEnvironmentProviderStatuses()}
        />
      </Reveal>

      <Reveal>
        <ProviderSpendSummary spend={spend} />
      </Reveal>
    </>
  );
}
