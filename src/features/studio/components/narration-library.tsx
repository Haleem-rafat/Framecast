"use client";

import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { Mic, Play } from "lucide-react";

import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { RelativeTime } from "@/components/shared/relative-time";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { VideoStatusBadge } from "@/features/videos/components/video-status-badge";
import type { NarrationEntry } from "@/features/studio/types";
import { formatDuration } from "@/utils/format";

/**
 * Every narration the operator has ever paid for, with one player.
 *
 * One player rather than an `<audio>` per row on purpose: a browser given
 * thirty audio elements pointing at thirty session-guarded routes will start
 * fetching metadata for all of them, and each of those requests reads the
 * whole MP3 off disk through `/api/videos/[id]/narration` (that route reads
 * the object whole — see its own comment). Playing one at a time is also
 * what an operator actually does.
 */
export function NarrationLibrary({ narrations }: { narrations: NarrationEntry[] }) {
  const [playing, setPlaying] = useState<NarrationEntry | null>(null);

  const onPlay = useCallback((entry: NarrationEntry) => {
    setPlaying(entry);
  }, []);

  const columns = useMemo<DataTableColumn<NarrationEntry>[]>(
    () => [
      {
        id: "video",
        header: "Video",
        cell: (entry) => (
          <Link href={`/videos/${entry.videoId}`} className="hover:underline">
            <p className="font-medium">{entry.videoTitle}</p>
            <p className="text-muted-foreground truncate text-xs">
              {entry.projectName}
            </p>
          </Link>
        ),
        sortValue: (entry) => entry.videoTitle,
        filterValue: (entry) => `${entry.videoTitle} ${entry.projectName}`,
        alwaysVisible: true,
      },
      {
        id: "status",
        header: "Status",
        cell: (entry) => <VideoStatusBadge status={entry.videoStatus} />,
        filterValue: (entry) => entry.videoStatus,
      },
      {
        id: "voice",
        header: "Voice",
        // The id is the fallback, not a second line: ElevenLabs' timestamped
        // endpoint returns no human name, so `voiceName` is only filled in
        // for voices this app already knows by name (see KNOWN_VOICE_NAMES in
        // voiceover.service.ts). Showing "—" for the rest would hide the one
        // identifier that does exist.
        cell: (entry) => entry.voiceName ?? entry.voiceId,
        sortValue: (entry) => entry.voiceName ?? entry.voiceId,
        filterValue: (entry) => `${entry.voiceName ?? ""} ${entry.voiceId}`,
        cellClassName: "text-sm",
      },
      {
        id: "duration",
        header: "Length",
        cell: (entry) =>
          entry.durationSeconds === null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            formatDuration(entry.durationSeconds)
          ),
        sortValue: (entry) => entry.durationSeconds,
        firstSortDirection: "desc",
        align: "right",
        cellClassName: "font-mono text-sm",
      },
      {
        id: "createdAt",
        header: "Synthesised",
        cell: (entry) => <RelativeTime date={entry.createdAt} />,
        sortValue: (entry) => entry.createdAt,
        firstSortDirection: "desc",
        cellClassName: "text-muted-foreground text-sm",
      },
      {
        id: "play",
        header: "",
        cell: (entry) => (
          <Button
            variant="ghost"
            size="sm"
            // A row whose `audioUrl` was never written has nothing to stream;
            // the route would answer 404 and the player would sit silent.
            disabled={!entry.hasAudio}
            onClick={() => onPlay(entry)}
          >
            <Play />
            Listen
          </Button>
        ),
        align: "right",
        alwaysVisible: true,
      },
    ],
    [onPlay],
  );

  return (
    <div className="space-y-4">
      <DataTable
        rows={narrations}
        columns={columns}
        getRowId={(entry) => entry.videoId}
        caption="Narration across every video"
        searchPlaceholder="Search narration"
        pageSize={25}
        columnToggle
        empty={
          <EmptyState
            icon={Mic}
            title="No narration yet"
            description="Narration is synthesised once a script is approved and the pipeline runs. Every take shows up here."
          />
        }
      />

      {playing && (
        <Card>
          <CardContent className="space-y-3">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">{playing.videoTitle}</p>
              <p className="text-muted-foreground text-xs">
                {playing.voiceName ?? playing.voiceId}
                {playing.durationSeconds !== null &&
                  ` · ${formatDuration(playing.durationSeconds)}`}
              </p>
            </div>
            {/* Keyed by the video so switching rows remounts the element.
              * Changing `src` on a live <audio> does not reliably reload it,
              * and a player that keeps playing the previous narration under a
              * new title is worse than one that visibly restarts. */}
            <audio
              key={playing.videoId}
              controls
              autoPlay
              preload="metadata"
              src={`/api/videos/${playing.videoId}/narration`}
              className="w-full"
            >
              Your browser cannot play this narration.
            </audio>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
