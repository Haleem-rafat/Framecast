"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Check, History } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RelativeTime } from "@/components/shared/relative-time";
import { setActiveVersionAction } from "@/actions/script.action";
import { cn } from "@/lib/utils";

interface VersionSummary {
  id: string;
  version: number;
  wordCount: number;
  createdAt: Date;
  model: string | null;
}

export function VersionHistory({
  videoId,
  versions,
  activeVersionId,
}: {
  videoId: string;
  versions: VersionSummary[];
  activeVersionId: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function onSelect(versionId: string) {
    if (versionId === activeVersionId) return;

    startTransition(async () => {
      const result = await setActiveVersionAction(videoId, versionId);

      if (!result.ok) {
        toast.error("Could not switch versions", {
          description: result.error.message,
        });
        return;
      }

      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <History className="size-4" />
          Version history
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {versions.length === 0 ? (
          <p className="text-muted-foreground text-sm">No versions yet.</p>
        ) : (
          versions.map((version) => {
            const isActive = version.id === activeVersionId;

            return (
              <button
                key={version.id}
                type="button"
                onClick={() => onSelect(version.id)}
                disabled={isPending}
                className={cn(
                  "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-50",
                  isActive && "bg-accent/50",
                )}
              >
                <span className="flex items-center gap-2">
                  {isActive ? (
                    <Check className="text-primary size-3.5" />
                  ) : (
                    <span className="size-3.5" />
                  )}
                  <span>v{version.version}</span>
                  {isActive && (
                    <Badge variant="outline" className="text-[10px]">
                      Active
                    </Badge>
                  )}
                </span>
                <span className="text-muted-foreground text-xs">
                  <RelativeTime date={version.createdAt} />
                </span>
              </button>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
