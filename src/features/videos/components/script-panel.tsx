"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2, RotateCw, Save, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { Textarea } from "@/components/ui/textarea";
import { generateScriptAction, saveScriptEditAction } from "@/actions/script.action";
import type { VideoStatus } from "@/generated/prisma/enums";

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

  // A new version — from Generate, Regenerate, or picking a different one in
  // the history sidebar — replaces what the operator is looking at. Their own
  // in-progress edits between actions are not preserved across that swap.
  useEffect(() => {
    setContent(activeVersion?.content ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeVersion?.id]);

  const isDraft = status === "DRAFT";
  const isDirty = content !== (activeVersion?.content ?? "");

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

  if (!activeVersion) {
    return (
      <Card>
        <CardContent className="py-10">
          <EmptyState
            icon={FileText}
            title="No script yet"
            description="Generate a script from the video's topic using the default script prompt template."
            action={
              <Button onClick={onGenerate} disabled={!isDraft || isPending}>
                {isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}
                Generate script
              </Button>
            }
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-muted-foreground text-sm">
            Version {activeVersion.version} · {activeVersion.wordCount} words
          </p>
          <div className="flex items-center gap-2">
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

        <Textarea
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
