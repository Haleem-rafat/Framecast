import { CircleCheck, CircleX } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { RelativeTime } from "@/components/shared/relative-time";
import { aiProviderTypes } from "@/schemas/provider.schema";
import { CredentialDialog } from "@/features/providers/components/credential-dialog";
import { RevokeCredentialButton } from "@/features/providers/components/revoke-credential-button";
import { TestCredentialButton } from "@/features/providers/components/test-credential-button";
import { PROVIDER_LABELS } from "@/features/providers/provider-labels";
import type { CredentialSummary } from "@/services/provider-credential.service";

export function ProviderTable({
  credentials,
}: {
  credentials: CredentialSummary[];
}) {
  const byProvider = new Map(credentials.map((one) => [one.provider, one]));

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Provider</TableHead>
          <TableHead>Key</TableHead>
          <TableHead>Last tested</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {/* One row per known provider type, not per row in the table — an
            unconfigured provider still needs an "Add key" affordance. */}
        {aiProviderTypes.map((provider) => {
          const credential = byProvider.get(provider);

          return (
            <TableRow key={provider}>
              <TableCell className="font-medium">
                {PROVIDER_LABELS[provider]}
              </TableCell>
              <TableCell>
                {credential ? (
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm">
                      •••• {credential.keyLastFour}
                    </span>
                    {credential.label && (
                      <span className="text-muted-foreground text-xs">
                        {credential.label}
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="text-muted-foreground text-sm">
                    Not configured
                  </span>
                )}
              </TableCell>
              <TableCell>
                {credential?.lastTestedAt ? (
                  <div className="flex items-center gap-1.5 text-sm">
                    {credential.lastTestOk ? (
                      <CircleCheck className="text-emerald-600 dark:text-emerald-400 size-3.5" />
                    ) : (
                      <CircleX className="text-destructive size-3.5" />
                    )}
                    <RelativeTime date={credential.lastTestedAt} />
                  </div>
                ) : credential ? (
                  <Badge variant="outline">Never tested</Badge>
                ) : (
                  <span className="text-muted-foreground text-sm">—</span>
                )}
              </TableCell>
              <TableCell>
                <div className="flex items-center justify-end gap-2">
                  {credential ? (
                    <>
                      <TestCredentialButton provider={provider} />
                      <CredentialDialog
                        provider={provider}
                        existingLabel={credential.label}
                      />
                      <RevokeCredentialButton provider={provider} />
                    </>
                  ) : (
                    <CredentialDialog provider={provider} />
                  )}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
