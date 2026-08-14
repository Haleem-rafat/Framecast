"use client";

import { useState } from "react";
import { Download, Mic, Video as VideoIcon } from "lucide-react";

import { MediaPlayer } from "@/components/shared/media-player";
import { Button } from "@/components/ui/button";
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
      Couldn&apos;t load the preview link. Reloading the page will generate a
      fresh one.
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

/** The reason the render's own route is the one route in this app that 404s
 *  for a video that plainly exists. */
const RECLAIMED_MESSAGE =
  "The local render is no longer on disk. Publishing deletes it once YouTube confirms the upload — YouTube now holds the only copy.";

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
  /**
   * The reclaim can also land *after* this page rendered.
   *
   * `resolveRenderPreview` stats the file, so a `render.url` arriving here is a
   * file that existed a moment ago — but publishing runs in a worker, and an
   * operator who publishes in one tab and presses play in another gets a 404
   * from a link the server had every reason to hand out. The player reports it,
   * and the embed is the same fallback the server-side case already uses.
   */
  const [renderGone, setRenderGone] = useState(false);

  // Neither a RenderJob nor a VoiceOver exists yet — nothing to preview, and
  // no section-shaped hole where one would otherwise go.
  // A published video whose local render has been reclaimed has no `render`
  // at all — resolveRenderPreview stats the file, finds it gone, and returns
  // null. Before the embed existed that emptied this whole section and the
  // operator's own published video simply disappeared from their studio.
  if (!render && !audio && !youtubeVideoId) {
    return null;
  }

  const durationLabel =
    durationSeconds != null ? formatDuration(durationSeconds) : null;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {(render || youtubeVideoId) && (
        <div className="space-y-3 lg:col-span-2">
          <h3 className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
            <VideoIcon aria-hidden="true" className="size-3.5" />
            Rendered video
          </h3>
          {render?.url && !(renderGone && youtubeVideoId) ? (
            <>
              <MediaPlayer
                shape="landscape"
                label="Rendered video"
                src={render.url}
                errorMessage={RECLAIMED_MESSAGE}
                onError={() => setRenderGone(true)}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-muted-foreground text-xs">
                  {metaLine([
                    durationLabel,
                    RENDER_RESOLUTION,
                    render.sizeBytes != null
                      ? formatBytes(render.sizeBytes)
                      : null,
                  ])}
                </p>
                {/* Withdrawn the moment the player reports the file gone: a
                    download of a URL that has just 404'd is a button whose
                    only outcome is an error page. */}
                {!renderGone && (
                  <Button asChild variant="outline" size="sm">
                    {/* `render.url` is this app's own streaming route
                     * (/api/videos/[id]/file), not a signed Supabase URL —
                     * same-origin, so `download` triggers a real save
                     * instead of just opening the file in a new tab. */}
                    <a
                      href={render.url}
                      download
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Download />
                      Download
                    </a>
                  </Button>
                )}
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
        </div>
      )}

      {audio && (
        <div
          className={
            render || youtubeVideoId ? "space-y-3" : "space-y-3 lg:col-span-3"
          }
        >
          <h3 className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
            <Mic aria-hidden="true" className="size-3.5" />
            Narration
          </h3>
          {audio.url ? (
            <>
              <MediaPlayer
                shape="audio"
                label="Narration audio"
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
        </div>
      )}
    </div>
  );
}
