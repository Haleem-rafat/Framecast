"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { AudioLines, Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { renarrateVideoAction } from "@/actions/video.action";
import { VoicePicker } from "@/components/shared/voice-picker";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogTrigger,
} from "@/components/shared/responsive-dialog";
import type { VideoStatus } from "@/generated/prisma/enums";

/**
 * Why this video cannot be re-narrated, in the operator's words, or null when
 * it can.
 *
 * Computed here as well as enforced in `VideoService.requestRenarration`, and
 * the two are not redundant: the service's refusals are the ones that matter
 * (they are what a stale page, a second tab or a hand-made request runs into),
 * while these are what stop the button appearing at all in the states where
 * pressing it could only ever fail. A disabled button with no explanation
 * reads as a bug; a click that spends a round trip to be told "no" reads as
 * one too. The wording is deliberately the same shape as the service's so an
 * operator who hits both hears one voice, not two.
 *
 * `leaseIsLive` covers more than `GENERATING`/`RENDERING`: `render.service.ts`
 * commits `READY` the moment the encode succeeds while the worker is still
 * running metadata and thumbnail behind it, holding the lease the whole time
 * (see `PipelineState.isFinalizing`). A `READY` video with a live lease is
 * still a video a worker is inside.
 */
function refusal(
  status: VideoStatus,
  hasNarration: boolean,
  leaseIsLive: boolean,
): string | null {
  if (status === "PUBLISHED") {
    return (
      "This video is on YouTube, and nothing here can replace the file that is " +
      "up there — publishing is one-shot, and it reclaimed this video's render " +
      "and footage to free the disk. Re-narrating would make a second, " +
      "different video; you would have to upload it as its own video."
    );
  }

  if (leaseIsLive) {
    return (
      "The render worker is holding this video right now. Cancel it from the " +
      "pipeline panel and wait for it to stop before changing the voice."
    );
  }

  if (!hasNarration) {
    return (
      "This video has not been narrated yet, so there is nothing to replace. " +
      "It narrates in the channel's voice on its first run — change that on " +
      "the channel's branding screen if you want a different one from the start."
    );
  }

  return null;
}

/**
 * Re-narrates a finished video in a different voice.
 *
 * ## Why this is a dialog and not a dropdown that saves
 *
 * The obvious shape for "change the sound" is a picker that writes a value.
 * That shape would be a lie here. Narration is generated once and everything
 * downstream is derived from it: ElevenLabs' character-level alignment places
 * every caption and converts every script cue into the second its clip starts,
 * so a different voice — which speaks at a different rate — invalidates the
 * captions, the clip timings and the render along with the audio. What the
 * operator is actually asking for is a re-run of the pipeline from narration
 * onward, and it is presented as one: it costs real ElevenLabs characters and
 * a real encode, it takes minutes rather than being instant, and it throws
 * away the shorts cut from the old narration. All four of those are stated
 * before the button that starts it, in the same "What this run spends" shape
 * the approve dialog uses.
 *
 * ## Why the confirm is disabled on the current voice
 *
 * Re-narrating in the voice it already has would spend the whole allowance and
 * the whole encode to produce the same video. Nothing refuses it server-side
 * — it is not incorrect, merely pointless — so it is refused here, where the
 * operator can see which row is already selected and why the button is not
 * lit.
 */
export function RenarrateVoiceButton({
  videoId,
  status,
  currentVoiceId,
  currentVoiceName,
  leaseIsLive,
  characterCount,
  shortCount,
}: {
  videoId: string;
  status: VideoStatus;
  /** The voice this video's *existing* narration was made in — a fact about
   *  the recorded audio, not about the channel, which may well have been
   *  changed since. Null when the video has never been narrated. */
  currentVoiceId: string | null;
  currentVoiceName: string | null;
  /** True while a worker holds this video's lease. See `refusal`. */
  leaseIsLive: boolean;
  /** The active script's length. Narration is billed per character, so this is
   *  the one number in the dialog that is an invoice rather than an estimate —
   *  the same value, for the same reason, that the approve dialog states. */
  characterCount: number;
  /** How many shorts this discards. Stated before the click, never after. */
  shortCount: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [choice, setChoice] = useState<{ voiceId: string; voiceName: string | null }>(
    { voiceId: currentVoiceId ?? "", voiceName: currentVoiceName },
  );

  const reason = refusal(status, currentVoiceId !== null, leaseIsLive);

  if (reason) {
    return (
      <p className="text-muted-foreground flex max-w-prose items-start gap-2 text-xs">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        {reason}
      </p>
    );
  }

  const unchanged = choice.voiceId === currentVoiceId;

  function onOpenChange(next: boolean) {
    if (isPending) return;

    setOpen(next);

    // Reset to the video's real voice every time the dialog closes. A
    // half-made choice left selected from last time is exactly how a
    // three-minute encode gets started by accident.
    if (!next) {
      setChoice({ voiceId: currentVoiceId ?? "", voiceName: currentVoiceName });
    }
  }

  function onConfirm() {
    startTransition(async () => {
      const result = await renarrateVideoAction(videoId, {
        voiceId: choice.voiceId,
        voiceName: choice.voiceName,
      });

      if (!result.ok) {
        // The service's refusals are complete sentences naming the real cause
        // (published, held by a worker, never narrated), so they are shown
        // verbatim rather than replaced with a generic failure.
        toast.error("Could not re-narrate this video", {
          description: result.error.message,
        });
        return;
      }

      setOpen(false);

      toast.success(`Queued a re-narration in ${choice.voiceName ?? choice.voiceId}`, {
        description:
          "The worker synthesises the new narration, rebuilds the captions and " +
          "clip timings from it, and renders the video again. Watch the pipeline " +
          "panel." +
          (result.data.shortsRemoved > 0
            ? ` The ${result.data.shortsRemoved} short${
                result.data.shortsRemoved === 1 ? "" : "s"
              } cut from the old narration were discarded.`
            : ""),
      });

      router.refresh();
    });
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <div className="flex flex-wrap items-center gap-2">
        <ResponsiveDialogTrigger asChild>
          <Button variant="outline" size="sm">
            <AudioLines />
            Change voice
          </Button>
        </ResponsiveDialogTrigger>
        <p className="text-muted-foreground text-xs">
          Narrated by {currentVoiceName ?? currentVoiceId}. Changing it
          re-narrates and re-renders — it does not edit the file that exists.
        </p>
      </div>

      <ResponsiveDialogContent className="sm:max-w-lg">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Re-narrate in another voice</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Nothing here edits the video that exists. The narration is
            synthesised again in the voice you pick, and the captions, the clip
            timings and the render are all rebuilt from it — because all three
            are derived from where the words fall in the audio.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody className="space-y-4">
          <VoicePicker
            value={choice.voiceId}
            onChange={(voiceId, voiceName) =>
              setChoice({
                voiceId,
                // The list is the only place a name can come from. Keep the one
                // already recorded when the operator re-selects the voice the
                // video already has and ElevenLabs could not be reached to
                // confirm it — otherwise a saved name would be dropped by
                // clicking the row it describes.
                voiceName:
                  voiceName ?? (voiceId === currentVoiceId ? currentVoiceName : null),
              })
            }
            unlistedName={
              choice.voiceId === currentVoiceId
                ? (currentVoiceName ?? "This video's voice")
                : "Chosen voice"
            }
            unlistedDetail={(voiceId) => (
              <span className="text-muted-foreground block text-xs">
                <span className="font-mono">{voiceId}</span> — what this video is
                narrated in now. It is not in the list above, either because
                ElevenLabs could not be reached or because it has since been
                removed from your account.
              </span>
            )}
            ariaLabel="Narration voice"
            disabled={isPending}
          />

          <div className="space-y-1.5">
            <p className="text-sm font-medium">What this run spends</p>
            <ul className="text-muted-foreground space-y-1 text-xs">
              <li>
                {characterCount.toLocaleString()} characters of your ElevenLabs
                allowance — the whole script again, billed the moment the worker
                picks this up. Nothing about the existing narration is reused.
              </li>
              <li>
                A full re-render: two encoding passes over every frame, on the
                same worker everything else queues behind.
              </li>
              <li>
                No new footage. The clips this video already has are kept and
                re-timed against the new narration, because they were chosen
                from the script rather than from the audio.
              </li>
            </ul>
          </div>

          {shortCount > 0 && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>
                This discards {shortCount} short
                {shortCount === 1 ? "" : "s"}
              </AlertTitle>
              <AlertDescription>
                <p>
                  A short is a window of seconds into this video&apos;s
                  timeline, and its captions are sliced out of the narration
                  alignment. Both are measured against the audio that is about
                  to be replaced, so they would keep a Ready badge and a
                  playable file in a voice this video no longer has.
                </p>
                <p>
                  They are deleted now, files included. Generate a new set from
                  the shorts panel once the re-render finishes.
                </p>
              </AlertDescription>
            </Alert>
          )}
        </ResponsiveDialogBody>

        <ResponsiveDialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={isPending || unchanged}>
            {isPending ? <Loader2 className="animate-spin" /> : <AudioLines />}
            {unchanged ? "Pick a different voice" : "Re-narrate and re-render"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
