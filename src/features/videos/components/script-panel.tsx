"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2, RotateCw, Save, Sparkles, Upload, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { Textarea } from "@/components/ui/textarea";
import {
  generateScriptAction,
  importScriptAction,
  saveScriptEditAction,
} from "@/actions/script.action";
import type { VideoStatus } from "@/generated/prisma/enums";

/** Live word count for the importer, so an operator pasting a script can see
 * whether it is anywhere near the length they asked the prompt for before
 * committing it. Counts the same way the server does — whitespace-separated
 * runs — so the number shown here matches the one stored on the version. */
function countWordsInDraft(draft: string | null): number {
  const trimmed = (draft ?? "").trim();

  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

interface ActiveVersion {
  id: string;
  content: string;
  version: number;
  wordCount: number;
}

export function ScriptPanel({
  videoId,
  status,
  activeVersion,
}: {
  videoId: string;
  status: VideoStatus;
  activeVersion: ActiveVersion | null;
}) {
  const router = useRouter();
  const [content, setContent] = useState(activeVersion?.content ?? "");
  const [isPending, startTransition] = useTransition();
  // Import is its own draft, kept apart from `content` so opening the importer
  // and closing it again cannot destroy edits in progress on the live script.
  const [importDraft, setImportDraft] = useState<string | null>(null);
  const isImporting = importDraft !== null;

  // A new version — from Generate, Regenerate, or picking a different one in
  // the history sidebar — replaces what the operator is looking at. Their own
  // in-progress edits between actions are not preserved across that swap.
  useEffect(() => {
    setContent(activeVersion?.content ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVersion?.id]);

  const isDraft = status === "DRAFT";
  const isDirty = content !== (activeVersion?.content ?? "");

  function onImport() {
    const pasted = importDraft ?? "";

    startTransition(async () => {
      const result = await importScriptAction(videoId, pasted);

      if (!result.ok) {
        toast.error("Could not import that script", {
          description: result.error.message,
        });
        return;
      }

      toast.success(`Imported v${result.data.version} (${result.data.wordCount} words)`);
      setImportDraft(null);
      router.refresh();
    });
  }

  function onGenerate() {
    startTransition(async () => {
      const result = await generateScriptAction(videoId, {});

      if (!result.ok) {
        toast.error("Could not generate a script", {
          description: result.error.message,
        });
        return;
      }

      toast.success(`Generated v${result.data.version} (${result.data.wordCount} words)`);
      router.refresh();
    });
  }

  function onSaveEdit() {
    startTransition(async () => {
      const result = await saveScriptEditAction(videoId, content);

      if (!result.ok) {
        toast.error("Could not save your edit", {
          description: result.error.message,
        });
        return;
      }

      toast.success(`Saved as v${result.data.version}`);

      // Editing a section's opening can move or remove the sentence a b-roll
      // cue was anchored to (see anchorCues in src/lib/script-cues.ts and
      // scriptService.saveEdit, which is where orphanedCueCount comes from).
      // A cue that no longer resolves isn't a save failure — the edit still
      // succeeded — but footage.service.ts's collectPerCue can no longer
      // fetch matched footage for that section, so the operator needs to
      // know their edit had that side effect rather than silently getting
      // generic topic footage later at render time.
      if (result.data.orphanedCueCount > 0) {
        toast.warning(
          `${result.data.orphanedCueCount} section(s) lost their footage cue`,
          {
            description:
              "Those parts will use general footage for the topic instead. " +
              "Regenerate the script to get matched footage back.",
          },
        );
      }

      router.refresh();
    });
  }

  if (isImporting) {
    return (
      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="space-y-1">
              <h2 className="text-sm font-medium">Import a script</h2>
              <p className="text-muted-foreground text-xs">
                Paste narration only — every word is read aloud exactly as
                written. Footage is matched to the video&apos;s topic rather
                than to each line, because an imported script carries no
                per-section visual cues.
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setImportDraft(null)}
              disabled={isPending}
            >
              <X />
              Cancel
            </Button>
          </div>

          {/* A placeholder is not a label — it is gone the moment anything is
              typed, and it is not what assistive tech reads for the field's
              name. This is the only control in the panel, so there is nothing
              else for it to be labelled by. */}
          <Textarea
            aria-label="Script to import"
            value={importDraft ?? ""}
            onChange={(event) => setImportDraft(event.target.value)}
            rows={20}
            className="min-h-[480px] font-mono text-sm"
            disabled={isPending}
            placeholder="Paste your script here"
            autoFocus
          />

          <div className="flex items-center justify-between">
            <p className="text-muted-foreground text-xs">
              {countWordsInDraft(importDraft)} words
            </p>
            <Button
              onClick={onImport}
              disabled={!isDraft || isPending || (importDraft ?? "").trim().length === 0}
            >
              {isPending ? <Loader2 className="animate-spin" /> : <Upload />}
              Import script
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!activeVersion) {
    return (
      <Card>
        <CardContent className="py-10">
          <EmptyState
            icon={FileText}
            title="No script yet"
            description="Generate one from the video's topic using your default script prompt, or import a script you already wrote."
            action={
              <div className="flex items-center gap-2">
                <Button onClick={onGenerate} disabled={!isDraft || isPending}>
                  {isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}
                  Generate script
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setImportDraft("")}
                  disabled={!isDraft || isPending}
                >
                  <Upload />
                  Import script
                </Button>
              </div>
            }
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-3">
        {/* Import, Regenerate and Save edit do not fit beside the version
         * line at 375px, and an unwrapped row would scroll the page rather
         * than itself. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-muted-foreground text-sm">
            Version {activeVersion.version} · {activeVersion.wordCount} words
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setImportDraft("")}
              disabled={!isDraft || isPending}
            >
              <Upload />
              Import
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onGenerate}
              disabled={!isDraft || isPending}
            >
              {isPending ? <Loader2 className="animate-spin" /> : <RotateCw />}
              Regenerate
            </Button>
            <Button
              size="sm"
              onClick={onSaveEdit}
              disabled={!isDraft || !isDirty || !content.trim() || isPending}
            >
              {isPending ? <Loader2 className="animate-spin" /> : <Save />}
              Save edit
            </Button>
          </div>
        </div>

        {/* Named after the version it is showing, because the panel's whole
            point is that you can switch between versions — an unqualified
            "Script content" would read identically whichever one is loaded. */}
        <Textarea
          aria-label={`Script content, version ${activeVersion.version}`}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={20}
          className="min-h-[480px] font-mono text-sm"
          disabled={!isDraft || isPending}
          placeholder="Script content"
        />

        {!isDraft && (
          <p className="text-muted-foreground text-xs">
            This video is past the draft stage, so the script is locked.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
