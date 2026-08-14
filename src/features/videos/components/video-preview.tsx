import { Download, Mic, Video as VideoIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes, formatDuration } from "@/utils/format";

/** Renders always land at 1920x1080 — WIDTH/HEIGHT are hardcoded in
 * the render pipeline (ffmpeg-command.ts), so this is a fixed label rather than
 * per-video metadata pulled from a column. */
const RENDER_RESOLUTION = "1920×1080";

interface PreviewAsset {
  /** Null when the underlying row exists but signing its path failed — the
   * section still renders, just without a player, rather than the whole page
   * going down over a storage hiccup. */
  url: string | null;
  sizeBytes: number | null;
}

function metaLine(parts: Array<string | null>): string {
  return parts.filter((part): part is string => part !== null).join(" · ");
}

function UnavailableNotice() {
  return (
    <p className="text-muted-foreground text-sm">
      Couldn&apos;t load the preview link. Reloading the page will generate a fresh one.
    </p>
  );
}

/**
 * Plays the published video from YouTube when the local render is gone.
 *
 * Publishing deliberately deletes the local file — `publish.service.ts` reclaims
 * it once YouTube confirms the upload, because a 170MB render per video fills a
 * 40GB disk quickly and YouTube is now holding the authoritative copy. The
 * consequence nobody saw coming is that the operator's own video vanished from
 * their own studio the moment they published it: the player below points at
 * `/api/videos/[id]/file`, which 404s the instant the reclaim runs.
 *
 * An embed is the honest thing to show there. It is the same video, it is the
 * copy that now matters, and it costs no disk and no API quota to display —
 * unlike re-fetching the file, YouTube's iframe is served by YouTube.
 *
 * `youtube-nocookie.com` rather than `youtube.com`: this frame renders inside a
 * private studio page, and there is no reason for viewing your own draft to
 * seed advertising cookies.
 */
function YouTubeEmbed({ youtubeVideoId }: { youtubeVideoId: string }) {
  return (
    <iframe
      className="aspect-video w-full rounded-md bg-black"
      src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(youtubeVideoId)}`}
      title="Published video"
      allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
      allowFullScreen
    />
  );
}

export function VideoPreview({
  render,
  audio,
  durationSeconds,
  youtubeVideoId = null,
}: {
  render: PreviewAsset | null;
  audio: PreviewAsset | null;
  durationSeconds: number | null;
  /** Set once the video is on YouTube. Lets the card fall back to the embed
   * rather than a dead player after the local render has been reclaimed. */
  youtubeVideoId?: string | null;
}) {
  // Neither a RenderJob nor a VoiceOver exists yet — nothing to preview, and
  // no section-shaped hole where one would otherwise go.
  // A published video whose local render has been reclaimed has no `render`
  // at all — resolveRenderPreview stats the file, finds it gone, and returns
  // null. Before the embed existed that emptied this whole section and the
  // operator's own published video simply disappeared from their studio.
  if (!render && !audio && !youtubeVideoId) {
    return null;
  }

  const durationLabel = durationSeconds != null ? formatDuration(durationSeconds) : null;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {(render || youtubeVideoId) && (
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <VideoIcon className="size-4" />
              Rendered video
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {render?.url ? (
              <>
                {/* No <track> — captions are burned into the render itself.
                 *
                 * `preload="metadata"` because the default is `auto`: opening
                 * this page began streaming a finished render — hundreds of
                 * megabytes — before anyone pressed play, competing with the
                 * page's own requests for bandwidth. Metadata is all the
                 * player needs to show a duration and a scrub bar.
                 *
                 * `aria-label` because a bare <video> has no accessible name;
                 * the card's heading is a sibling, which is not an association
                 * a screen reader can make. */}
                <video
                  controls
                  preload="metadata"
                  aria-label="Rendered video"
                  className="aspect-video w-full rounded-md bg-black"
                  src={render.url}
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-muted-foreground text-xs">
                    {metaLine([
                      durationLabel,
                      RENDER_RESOLUTION,
                      render.sizeBytes != null ? formatBytes(render.sizeBytes) : null,
                    ])}
                  </p>
                  <Button asChild variant="outline" size="sm">
                    {/* `render.url` is this app's own streaming route
                     * (/api/videos/[id]/file), not a signed Supabase URL —
                     * same-origin, so `download` triggers a real save
                     * instead of just opening the file in a new tab. */}
                    <a href={render.url} download target="_blank" rel="noopener noreferrer">
                      <Download />
                      Download
                    </a>
                  </Button>
                </div>
              </>
            ) : youtubeVideoId ? (
              <>
                <YouTubeEmbed youtubeVideoId={youtubeVideoId} />
                <p className="text-muted-foreground text-xs">
                  {metaLine([
                    durationLabel,
                    RENDER_RESOLUTION,
                    "playing from YouTube — the local render was reclaimed after publishing",
                  ])}
                </p>
              </>
            ) : (
              <UnavailableNotice />
            )}
          </CardContent>
        </Card>
      )}

      {audio && (
        <Card className={render ? undefined : "lg:col-span-3"}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Mic className="size-4" />
              Narration
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {audio.url ? (
              <>
                <audio
                  controls
                  preload="metadata"
                  aria-label="Narration audio"
                  className="w-full"
                  src={audio.url}
                />
                <p className="text-muted-foreground text-xs">
                  {metaLine([
                    durationLabel,
                    audio.sizeBytes != null ? formatBytes(audio.sizeBytes) : null,
                  ])}
                </p>
              </>
            ) : (
              <UnavailableNotice />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
