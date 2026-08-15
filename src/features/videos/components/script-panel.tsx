"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  FileText,
  Loader2,
  RotateCw,
  Save,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  generateScriptAction,
  importScriptAction,
  saveScriptEditAction,
} from "@/actions/script.action";
import type { VideoStatus } from "@/generated/prisma/enums";
import {
  estimateSpokenSeconds,
  formatFit,
  formatRuntime,
  VERTICAL_MAX_SECONDS,
} from "@/lib/video-format";

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

/** One option in the prompt picker — see `listForCategory`, which selects
 *  exactly these three columns and nothing else. */
export interface ScriptTemplateOption {
  id: string;
  name: string;
  isDefault: boolean;
}

export function ScriptPanel({
  videoId,
  status,
  activeVersion,
  scriptTemplates,
}: {
  videoId: string;
  status: VideoStatus;
  activeVersion: ActiveVersion | null;
  /**
   * The operator's SCRIPT templates, default first, and empty for a video past
   * the draft stage — the page only fetches them where generating is possible.
   *
   * This is what makes a second script style worth having. Until this existed
   * the template was decided entirely by `UserSetting`'s category default:
   * `scriptService.generate` accepted a `templateId` and no caller in the app
   * ever passed one, so writing one video in a different style meant changing
   * a global default, generating, and changing it back.
   */
  scriptTemplates: ScriptTemplateOption[];
}) {
  const router = useRouter();
  const [content, setContent] = useState(activeVersion?.content ?? "");
  // Starts on whichever template is the category default — the one the server
  // would have chosen on its own — so the picker changes what an operator
  // *can* do without changing what happens if they ignore it. Falls back to
  // the first option for an operator whose templates have no default at all
  // (the state `getDefault` throws `NotFoundError` for), which turns that
  // error into a working generate.
  const [templateId, setTemplateId] = useState<string | undefined>(
    () =>
      scriptTemplates.find((template) => template.isDefault)?.id ??
      scriptTemplates[0]?.id,
  );
  // Generated: nothing stops a future list view mounting two of these, and a
  // duplicated id would point every label at the first select on the page.
  const templatePickerId = useId();
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
  const showTemplatePicker = isDraft && scriptTemplates.length > 1;

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

      toast.success(
        `Imported v${result.data.version} (${result.data.wordCount} words)`,
      );
      setImportDraft(null);
      router.refresh();
    });
  }

  function onGenerate() {
    startTransition(async () => {
      // `templateId` is undefined only when the operator has no SCRIPT
      // templates at all, and `generate` falls back to the category default
      // for an absent one — which then throws the `NotFoundError` that names
      // the real problem. Sending an empty string instead would send a
      // template id that cannot exist and report it as a missing template.
      const result = await generateScriptAction(videoId, { templateId });

      if (!result.ok) {
        toast.error("Could not generate a script", {
          description: result.error.message,
        });
        return;
      }

      toast.success(
        `Generated v${result.data.version} (${result.data.wordCount} words)`,
      );
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
      // Bare, like every panel on this page: the collapsible `VideoSection`
      // around it supplies the card and the "Script" heading.
      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1">
            <h2 className="text-sm font-medium">Import a script</h2>
            <p className="text-muted-foreground text-xs">
              Paste narration only — every word is read aloud exactly as
              written. Footage is matched to the video&apos;s topic rather than
              to each line, because an imported script carries no per-section
              visual cues.
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
          // `field-sizing-content` grows the box to its text, with min/max as the
          // bounds. Pinned at 480px it reserved half a screen of empty dark for a
          // 147-word script — and this panel sits above everything else on the
          // page, so that emptiness pushed the rest of the video down with it.
          className="max-h-[70vh] min-h-[14rem] font-mono text-sm field-sizing-content"
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
            disabled={
              !isDraft || isPending || (importDraft ?? "").trim().length === 0
            }
          >
            {isPending ? <Loader2 className="animate-spin" /> : <Upload />}
            Import script
          </Button>
        </div>
      </div>
    );
  }

  /**
   * Which prompt this generate uses, chosen per video.
   *
   * Hidden when there is nothing to choose between — one template, or none.
   * A select with a single option is a control that cannot be operated, and
   * this panel already has three buttons competing for a narrow column.
   */
  const templatePicker = showTemplatePicker ? (
    <div className="flex items-center gap-2">
      <Label htmlFor={templatePickerId} className="text-muted-foreground text-xs">
        Prompt
      </Label>
      <Select
        value={templateId}
        onValueChange={setTemplateId}
        disabled={!isDraft || isPending}
      >
        <SelectTrigger id={templatePickerId} size="sm" className="w-52">
          <SelectValue placeholder="Pick a prompt" />
        </SelectTrigger>
        <SelectContent>
          {scriptTemplates.map((template) => (
            <SelectItem key={template.id} value={template.id}>
              {template.name}
              {template.isDefault ? " (default)" : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  ) : null;

  if (!activeVersion) {
    return (
      <div className="py-6">
        <EmptyState
          icon={FileText}
          title="No script yet"
          description={
            showTemplatePicker
              ? "Generate one from the video's topic using any prompt in your library, or import a script you already wrote."
              : "Generate one from the video's topic using your default script prompt, or import a script you already wrote."
          }
          action={
            <div className="flex flex-col items-center gap-3">
              {templatePicker}
              <div className="flex items-center gap-2">
                <Button onClick={onGenerate} disabled={!isDraft || isPending}>
                  {isPending ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Sparkles />
                  )}
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
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Import, Regenerate and Save edit do not fit beside the version
       * line at 375px, and an unwrapped row would scroll the page rather
       * than itself. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          Version {activeVersion.version} · {activeVersion.wordCount} words
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {/* Beside Regenerate rather than above it: the picker only changes
            * what the next generate does, so reading left to right gives
            * "this prompt, regenerate". */}
          {templatePicker}
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
        // `field-sizing-content` grows the box to its text, with min/max as the
        // bounds. Pinned at 480px it reserved half a screen of empty dark for a
        // 147-word script — and this panel sits above everything else on the
        // page, so that emptiness pushed the rest of the video down with it.
        className="max-h-[70vh] min-h-[14rem] font-mono text-sm field-sizing-content"
        disabled={!isDraft || isPending}
        placeholder="Script content"
      />

      {/* Which output this script can actually become, said where the script
        * is read rather than only in the approve dialog. Approving is the
        * moment the choice is committed, but this is the moment it can still
        * be changed — regenerating a shorter script is a click away here and
        * impossible one screen later. */}
      {isDraft && activeVersion.wordCount > 0 && (
        <p className="text-muted-foreground text-xs">
          About {formatRuntime(estimateSpokenSeconds(activeVersion.wordCount))}{" "}
          spoken.{" "}
          {formatFit("VERTICAL", activeVersion.wordCount).verdict === "fits"
            ? "Short enough for either a full video or a vertical Short."
            : `Suits a full video — a Short has to be under ${formatRuntime(VERTICAL_MAX_SECONDS)}, so regenerate with a shorter target if you want one.`}
        </p>
      )}

      {!isDraft && (
        <p className="text-muted-foreground text-xs">
          This video is past the draft stage, so the script is locked.
        </p>
      )}
    </div>
  );
}
