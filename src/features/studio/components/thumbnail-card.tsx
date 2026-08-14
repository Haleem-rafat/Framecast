"use client";

import NextImage from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Check, CircleAlert, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import {
  regenerateThumbnailAction,
  setActiveThumbnailVersionAction,
} from "@/actions/studio.action";
import { RelativeTime } from "@/components/shared/relative-time";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { VideoStatusBadge } from "@/features/videos/components/video-status-badge";
import type { ThumbnailEntry } from "@/features/studio/types";
import { cn } from "@/lib/utils";

/**
 * One video's thumbnails: what YouTube would get, and every attempt that lost.
 *
 * The version strip is the reason this page exists. `ThumbnailService` only
 * ever appends and auto-activates, so before now the newest generation was
 * the only reachable one and every earlier attempt was a row nothing could
 * display — even though `ThumbnailVersion` exists precisely so attempts can
 * be compared.
 */
export function ThumbnailCard({ entry }: { entry: ThumbnailEntry }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  // What the image area is showing, which is not necessarily what is active:
  // comparing attempts means looking at one while another is still the one
  // that would publish.
  const [previewId, setPreviewId] = useState<string | null>(
    entry.activeVersionId ?? entry.versions[0]?.id ?? null,
  );

  const preview =
    entry.versions.find((version) => version.id === previewId) ?? entry.versions[0];
  const isPublished = entry.videoStatus === "PUBLISHED";
  const isActivePreview = preview !== undefined && preview.id === entry.activeVersionId;

  function onUseVersion(versionId: string) {
    startTransition(async () => {
      const result = await setActiveThumbnailVersionAction(entry.videoId, versionId);

      if (!result.ok) {
        toast.error("Could not switch thumbnail", {
          description: result.error.message,
        });
        return;
      }

      toast.success("Thumbnail updated", {
        description: "This version is what the video will publish with.",
      });
      router.refresh();
    });
  }

  function onRegenerate() {
    startTransition(async () => {
      const result = await regenerateThumbnailAction(entry.videoId);

      if (!result.ok) {
        toast.error("Could not generate a thumbnail", {
          description: result.error.message,
        });
        return;
      }

      setConfirmOpen(false);
      // The new version is appended *and* made active by ThumbnailService, so
      // the preview follows the refresh rather than holding the old one.
      setPreviewId(null);
      toast.success("New thumbnail generated", {
        description: "It has been made this video's active version.",
      });
      router.refresh();
    });
  }

  return (
    <Card className="overflow-hidden pt-0">
      <div className="bg-muted relative aspect-video w-full">
        {preview && (
          <NextImage
            // `unoptimized` because the optimizer fetches the source URL
            // itself, server-to-server and without the operator's session
            // cookie — and the route behind this src refuses exactly that.
            // The bytes are already a 1280x720 JPEG that FFmpeg encoded (see
            // thumbnail-command.ts), so there is nothing to optimise anyway.
            unoptimized
            fill
            sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
            src={`/studio/thumbnail/image/${preview.id}`}
            alt={`Thumbnail v${preview.version} for ${entry.videoTitle}`}
            className="object-cover"
          />
        )}
      </div>

      <CardContent className="space-y-3">
        <div className="space-y-1">
          <Link
            href={`/videos/${entry.videoId}`}
            className="font-medium hover:underline"
          >
            {entry.videoTitle}
          </Link>
          <div className="flex items-center gap-2">
            <VideoStatusBadge status={entry.videoStatus} />
            <span className="text-muted-foreground truncate text-xs">
              {entry.projectName}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {entry.versions.map((version) => {
            const isActive = version.id === entry.activeVersionId;

            return (
              <button
                key={version.id}
                type="button"
                onClick={() => setPreviewId(version.id)}
                aria-pressed={version.id === preview?.id}
                className={cn(
                  "focus-visible:ring-ring/50 inline-flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-xs transition-colors outline-none focus-visible:ring-3",
                  version.id === preview?.id
                    ? "border-primary/40 bg-primary/10"
                    : "border-transparent bg-muted hover:bg-accent",
                )}
              >
                {isActive && <Check className="text-primary size-3" />}v
                {version.version}
              </button>
            );
          })}
        </div>

        {preview && (
          <p className="text-muted-foreground text-xs">
            v{preview.version} · <RelativeTime date={preview.createdAt} />
            {preview.model && ` · ${preview.model}`}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {preview && !isActivePreview && !isPublished && (
            <Button
              size="sm"
              variant="outline"
              disabled={isPending}
              onClick={() => onUseVersion(preview.id)}
            >
              {isPending ? <Loader2 className="animate-spin" /> : <Check />}
              Use this version
            </Button>
          )}

          <RegenerateButton
            entry={entry}
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            isPending={isPending}
            onConfirm={onRegenerate}
          />
        </div>

        {isPublished && (
          <p className="text-muted-foreground text-xs text-balance">
            This video is already on YouTube. Its thumbnail was attached during
            the publish and nothing here can replace it — use YouTube Studio.
          </p>
        )}
        {!isPublished && !entry.hasScript && (
          <p className="text-muted-foreground text-xs text-balance">
            A thumbnail is built from the script&apos;s opening, so this video
            needs an active script version before another can be generated.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The one control on this page that spends money, and the confirmation that
 * says so before the click rather than after it.
 *
 * `isPending` disables the confirm button and blocks every route out of the
 * dialog while the generation is in flight, so a second click cannot start a
 * second image generation. The service refuses the two cases where the spend
 * could not possibly have an effect (a published video, a video with no
 * script) before the provider is reached; the button simply does not render
 * for them, so an operator never meets those refusals.
 */
function RegenerateButton({
  entry,
  open,
  onOpenChange,
  isPending,
  onConfirm,
}: {
  entry: ThumbnailEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isPending: boolean;
  onConfirm: () => void;
}) {
  if (entry.videoStatus === "PUBLISHED" || !entry.hasScript) {
    return null;
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" disabled={isPending}>
          <Sparkles />
          Generate another
        </Button>
      </DialogTrigger>

      <DialogContent
        showCloseButton={!isPending}
        onEscapeKeyDown={(event) => {
          if (isPending) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (isPending) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Generate another thumbnail</DialogTitle>
          <DialogDescription>
            This costs money every time it runs.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="text-muted-foreground space-y-2 text-sm">
            <p>
              One image generation is billed to your AI gateway account, then
              the headline and channel logo are composited onto it locally.
            </p>
            <p>
              Nothing is overwritten:{" "}
              <strong className="text-foreground">
                v{(entry.versions[0]?.version ?? 0) + 1}
              </strong>{" "}
              is appended to the {entry.versions.length}{" "}
              {entry.versions.length === 1 ? "version" : "versions"} this video
              already has, and becomes the active one. You can switch back
              afterwards.
            </p>
            <p className="flex items-start gap-2">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              It takes several seconds. Leave this dialog open until it
              finishes.
            </p>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button onClick={onConfirm} disabled={isPending}>
            {isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {isPending ? "Generating…" : "Generate — this spends money"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
