"use client";

import Link from "next/link";
import { useCallback, useMemo, useState, useTransition } from "react";
import { BookOpen, FileText } from "lucide-react";
import { toast } from "sonner";

import { readScriptVersionAction } from "@/actions/studio.action";
import { DataTable, type DataTableColumn } from "@/components/shared/data-table";
import { EmptyState } from "@/components/shared/empty-state";
import { RelativeTime } from "@/components/shared/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { VideoStatusBadge } from "@/features/videos/components/video-status-badge";
import type { ScriptLibraryEntry, ScriptVersionContent } from "@/features/studio/types";

/**
 * A count that reads as an absence when it is zero.
 *
 * Both columns this renders are "did the model give us this or not" rather
 * than "how many" — a script with no cues draws all its footage from the
 * topic pool, and one with no sources publishes with no citations. A bare `0`
 * makes that look like a tally; the muted word makes it look like the gap it
 * is.
 */
function CountOrNone({ count, unit }: { count: number; unit: string }) {
  if (count === 0) {
    return <span className="text-muted-foreground">None</span>;
  }

  return (
    <span>
      {count} {count === 1 ? unit : `${unit}s`}
    </span>
  );
}

interface Reading {
  versionId: string;
  videoTitle: string;
}

export function ScriptLibraryTable({ scripts }: { scripts: ScriptLibraryEntry[] }) {
  const [reading, setReading] = useState<Reading | null>(null);
  const [content, setContent] = useState<ScriptVersionContent | null>(null);
  const [isLoading, startLoading] = useTransition();

  // Stable across renders so the column list below can memoise on it — the
  // columns are rebuilt on every change to its identity otherwise, which
  // invalidates DataTable's own memos on every keystroke in its search box.
  const onRead = useCallback(
    (entry: ScriptLibraryEntry) => {
      if (!entry.activeVersion) return;

      const versionId = entry.activeVersion.id;
      setReading({ versionId, videoTitle: entry.videoTitle });
      // Cleared rather than left showing the previous script: the dialog
      // reopens instantly and stale narration under a new title is worse than
      // a skeleton.
      setContent(null);

      startLoading(async () => {
        const result = await readScriptVersionAction(versionId);

        if (!result.ok) {
          toast.error("Could not open that script", {
            description: result.error.message,
          });
          setReading(null);
          return;
        }

        setContent(result.data);
      });
    },
    [startLoading],
  );

  const columns = useMemo<DataTableColumn<ScriptLibraryEntry>[]>(
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
        id: "version",
        header: "Active",
        cell: (entry) =>
          entry.activeVersion ? (
            <span className="flex items-center gap-1.5">
              <span className="font-mono text-sm">v{entry.activeVersion.version}</span>
              {entry.versionCount > 1 && (
                <Badge variant="outline" className="text-[10px]">
                  {entry.versionCount} versions
                </Badge>
              )}
            </span>
          ) : (
            <span className="text-muted-foreground text-sm">None</span>
          ),
        sortValue: (entry) => entry.activeVersion?.version ?? null,
        firstSortDirection: "desc",
      },
      {
        id: "words",
        header: "Words",
        cell: (entry) =>
          entry.activeVersion ? (
            entry.activeVersion.wordCount.toLocaleString()
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
        sortValue: (entry) => entry.activeVersion?.wordCount ?? null,
        firstSortDirection: "desc",
        align: "right",
        cellClassName: "font-mono text-sm",
      },
      {
        id: "cues",
        header: "Cues",
        cell: (entry) => (
          <CountOrNone count={entry.activeVersion?.cueCount ?? 0} unit="cue" />
        ),
        sortValue: (entry) => entry.activeVersion?.cueCount ?? 0,
        firstSortDirection: "desc",
        cellClassName: "text-sm",
      },
      {
        id: "sources",
        header: "Sources",
        cell: (entry) => (
          <CountOrNone count={entry.activeVersion?.sourceCount ?? 0} unit="source" />
        ),
        sortValue: (entry) => entry.activeVersion?.sourceCount ?? 0,
        firstSortDirection: "desc",
        cellClassName: "text-sm",
      },
      {
        id: "model",
        header: "Model",
        // Null for an imported or hand-edited version — `ScriptService` keeps
        // those columns empty rather than recording a prompt nobody sent.
        cell: (entry) =>
          entry.activeVersion?.model ?? (
            <span className="text-muted-foreground">Written by hand</span>
          ),
        sortValue: (entry) => entry.activeVersion?.model ?? null,
        filterValue: (entry) => entry.activeVersion?.model ?? "hand written imported",
        cellClassName: "text-muted-foreground text-xs",
      },
      {
        id: "updatedAt",
        header: "Updated",
        cell: (entry) => <RelativeTime date={entry.updatedAt} />,
        sortValue: (entry) => entry.updatedAt,
        firstSortDirection: "desc",
        cellClassName: "text-muted-foreground text-sm",
      },
      {
        id: "read",
        header: "",
        cell: (entry) => (
          <Button
            variant="ghost"
            size="sm"
            disabled={!entry.activeVersion}
            onClick={() => onRead(entry)}
          >
            <BookOpen />
            Read
          </Button>
        ),
        align: "right",
        alwaysVisible: true,
      },
    ],
    [onRead],
  );

  return (
    <>
      <DataTable
        rows={scripts}
        columns={columns}
        getRowId={(entry) => entry.videoId}
        caption="Scripts across every video"
        searchPlaceholder="Search scripts"
        pageSize={25}
        columnToggle
        empty={
          <EmptyState
            icon={FileText}
            title="No scripts yet"
            description="Every script written for one of your videos shows up here — generated, imported or hand-edited."
          />
        }
      />

      <Dialog
        open={reading !== null}
        onOpenChange={(next) => {
          if (!next) {
            setReading(null);
            setContent(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{reading?.videoTitle}</DialogTitle>
            <DialogDescription>
              {content
                ? `Version ${content.version} — ${content.wordCount.toLocaleString()} words of narration, exactly as it is sent to ElevenLabs.`
                : "Loading the narration…"}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="max-h-[60vh] overflow-y-auto">
            {isLoading || !content ? (
              <div className="space-y-2">
                {Array.from({ length: 6 }, (_, index) => (
                  <Skeleton key={index} className="h-4 w-full" />
                ))}
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-sm leading-relaxed whitespace-pre-wrap">
                  {content.content}
                </p>

                {content.sources.length > 0 && (
                  <div className="space-y-1.5">
                    <h3 className="text-sm font-medium">Sources</h3>
                    {/* Held apart from the narration in the database for the
                      * reason stated on `ScriptVersion.sources`: `content` is
                      * read aloud verbatim, so a citation inside it would be
                      * spoken. They are shown here because the description
                      * this video publishes with is built from them. */}
                    <ul className="text-muted-foreground space-y-1 text-xs">
                      {content.sources.map((source) => (
                        <li key={source} className="break-all">
                          {source}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {content.prompt && (
                  <div className="space-y-1.5">
                    <h3 className="text-sm font-medium">Prompt</h3>
                    <p className="text-muted-foreground bg-muted/50 rounded-md p-3 text-xs whitespace-pre-wrap">
                      {content.prompt}
                    </p>
                  </div>
                )}
              </div>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
