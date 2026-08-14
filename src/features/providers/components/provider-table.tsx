"use client";

import { useMemo } from "react";
import { CircleCheck, CircleX } from "lucide-react";

import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { RelativeTime } from "@/components/shared/relative-time";
import { Badge } from "@/components/ui/badge";
import { CredentialDialog } from "@/features/providers/components/credential-dialog";
import { RevokeCredentialButton } from "@/features/providers/components/revoke-credential-button";
import { TestCredentialButton } from "@/features/providers/components/test-credential-button";
import { PROVIDER_LABELS } from "@/features/providers/provider-labels";
import { aiProviderTypes } from "@/schemas/provider.schema";
import type { CredentialSummary } from "@/services/provider-credential.service";

type ProviderRow = {
  provider: (typeof aiProviderTypes)[number];
  credential: CredentialSummary | undefined;
};

/**
 * No search box and no pagination: this table is a fixed ten rows in a
 * deliberate order, so both would be chrome over nothing. Sorting is offered
 * on the two columns that answer a real question — which provider, and which
 * key has gone longest without a successful test.
 */
export function ProviderTable({
  credentials,
}: {
  credentials: CredentialSummary[];
}) {
  const rows = useMemo<ProviderRow[]>(() => {
    const byProvider = new Map(credentials.map((one) => [one.provider, one]));

    // One row per known provider type, not per credential the operator has
    // saved — an unconfigured provider still needs an "Add key" affordance.
    return aiProviderTypes.map((provider) => ({
      provider,
      credential: byProvider.get(provider),
    }));
  }, [credentials]);

  const columns = useMemo<DataTableColumn<ProviderRow>[]>(
    () => [
      {
        id: "provider",
        header: "Provider",
        cell: (row) => PROVIDER_LABELS[row.provider],
        sortValue: (row) => PROVIDER_LABELS[row.provider],
        cellClassName: "font-medium",
        alwaysVisible: true,
      },
      {
        id: "key",
        header: "Key",
        cell: (row) =>
          row.credential ? (
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm">
                •••• {row.credential.keyLastFour}
              </span>
              {row.credential.label && (
                <span className="text-muted-foreground text-xs">
                  {row.credential.label}
                </span>
              )}
            </div>
          ) : (
            <span className="text-muted-foreground text-sm">Not configured</span>
          ),
      },
      {
        id: "lastTested",
        header: "Last tested",
        cell: (row) =>
          row.credential?.lastTestedAt ? (
            <div className="flex items-center gap-1.5 text-sm">
              {/* Pass and fail were a tick vs a cross in green vs red and
                * nothing else, so this column read as a bare timestamp to a
                * screen reader — "2 hours ago", with the part that says
                * whether the key actually works missing entirely. */}
              {row.credential.lastTestOk ? (
                <CircleCheck
                  aria-hidden="true"
                  className="text-emerald-700 dark:text-emerald-400 size-3.5"
                />
              ) : (
                <CircleX aria-hidden="true" className="text-destructive size-3.5" />
              )}
              <span className="sr-only">
                {row.credential.lastTestOk ? "Passed" : "Failed"},{" "}
              </span>
              <RelativeTime date={row.credential.lastTestedAt} />
            </div>
          ) : row.credential ? (
            <Badge variant="outline">Never tested</Badge>
          ) : (
            <span className="text-muted-foreground text-sm">—</span>
          ),
        // Ascending by default, i.e. stalest first: a key tested minutes ago
        // needs no attention, and never-tested rows sink to the bottom on
        // their own since they have no date at all.
        sortValue: (row) => row.credential?.lastTestedAt,
      },
      {
        id: "actions",
        header: "Actions",
        cell: (row) => (
          <div className="flex items-center justify-end gap-2">
            {row.credential ? (
              <>
                <TestCredentialButton provider={row.provider} />
                <CredentialDialog
                  provider={row.provider}
                  existingLabel={row.credential.label}
                />
                <RevokeCredentialButton provider={row.provider} />
              </>
            ) : (
              <CredentialDialog provider={row.provider} />
            )}
          </div>
        ),
        align: "right",
        alwaysVisible: true,
      },
    ],
    [],
  );

  return (
    <DataTable
      rows={rows}
      columns={columns}
      getRowId={(row) => row.provider}
      caption="Per-operator provider API keys"
    />
  );
}
