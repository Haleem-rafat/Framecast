"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Check, History } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RelativeTime } from "@/components/shared/relative-time";
import { setActiveVersionAction } from "@/actions/script.action";
import type { VideoStatus } from "@/generated/prisma/enums";
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
  status,
  versions,
  activeVersionId,
}: {
  videoId: string;
  status: VideoStatus;
  versions: VersionSummary[];
  activeVersionId: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // Same Gate 1 invariant script-panel.tsx enforces for editing: once the
  // video is past DRAFT, the approved content must stay exactly what it was
  // at approval. The service now rejects this regardless, but a disabled
  // button here means the operator never has a reason to hit that rejection.
  const isDraft = status === "DRAFT";

  function onSelect(versionId: string) {
    if (!isDraft || versionId === activeVersionId) return;

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
                // Which version is loaded was shown by a tick glyph and a
                // background tint — both invisible to a screen reader, which
                // heard an identical row per version. `aria-pressed` is the
                // state this control actually has.
                aria-pressed={isActive}
                onClick={() => onSelect(version.id)}
                disabled={isPending || !isDraft}
                className={cn(
                  // `disabled:opacity-50` used to dim these rows permanently:
                  // the list is disabled for the whole life of any video past
                  // draft, so version numbers and dates — still the useful
                  // record of what happened — were left under 3:1 forever. The
                  // fade now applies only while a request is in flight, which
                  // is the transient case it was meant for. Focus ring added
                  // because this is a hand-rolled button with no `Button`
                  // styling behind it, so it had none.
                  "focus-visible:ring-ring/50 flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition-colors outline-none hover:bg-accent/50 focus-visible:ring-3 disabled:pointer-events-none",
                  isPending && "opacity-50",
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
                    <Badge variant="outline" className="text-xs">
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
        {!isDraft && versions.length > 0 && (
          <p className="text-muted-foreground pt-1 text-xs">
            This video is past the draft stage, so the active version is locked.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
