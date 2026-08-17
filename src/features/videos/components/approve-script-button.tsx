"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import {
  CircleCheck,
  Loader2,
  MonitorPlay,
  Smartphone,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { approveScriptAction } from "@/actions/video.action";
import type { FootageStyle, VideoFormat } from "@/generated/prisma/enums";
import { isGeneratedFootage, needsCharacterSheet } from "@/lib/footage-styles";
import { scriptStylesUnder } from "@/lib/script-styles";
import { beatCountFor } from "@/lib/story-beats";
import {
  estimateSpokenSeconds,
  formatFit,
  formatRuntime,
  VERTICAL_MAX_SECONDS,
  VIDEO_FORMATS,
} from "@/lib/video-format";

/** Both formats, in the order the dialog offers them. Landscape first because
 *  it is what every video before this was, so an operator who opens this
 *  dialog by habit and presses the primary button gets what they have always
 *  got. */
const FORMAT_ORDER: VideoFormat[] = ["LANDSCAPE", "VERTICAL"];

const FORMAT_ICON: Record<VideoFormat, typeof MonitorPlay> = {
  LANDSCAPE: MonitorPlay,
  VERTICAL: Smartphone,
};

/**
 * The shipped script styles a Short can actually be written with, named by the
 * warning below.
 *
 * Computed from the catalogue's own `targetSeconds` rather than listed here,
 * so a style retargeted later appears or disappears from the advice on its
 * own. Module scope because the catalogue is a constant — nothing about this
 * changes per video, per render or per click.
 */
const SHORT_FORM_STYLES = scriptStylesUnder(VERTICAL_MAX_SECONDS);

/**
 * What each format actually spends, stated per format rather than once.
 *
 * The two are wildly different amounts of money and machine time and the
 * difference is entirely the script's length: narration is billed per
 * character by ElevenLabs, one stock clip is downloaded per script section,
 * and the render encodes every frame of the finished runtime twice (see
 * ffmpeg-command.ts's two-pass rationale). A minute of vertical costs roughly a
 * ninth of nine minutes of landscape — but only if the script is a minute long,
 * which is the whole reason the fit warning below exists.
 */
function costLines(
  format: VideoFormat,
  wordCount: number,
  characterCount: number,
  footageStyle: FootageStyle,
): string[] {
  const { estimatedSeconds } = formatFit(format, wordCount);
  const dimensions = format === "VERTICAL" ? "1080\u00d71920" : "1920\u00d71080";

  return [
    `About ${formatRuntime(estimatedSeconds)} of finished video, from the ${wordCount.toLocaleString()} words in this script.`,
    `${characterCount.toLocaleString()} characters of your ElevenLabs allowance, spent the moment the worker picks this up.`,
    // The footage line is the one that can be real money rather than quota and
    // machine time, so it is stated in currency when it is. Estimated from the
    // script's length exactly as the runtime above is, and by the same function
    // the collector will use — see `beatCountFor`, which is what actually
    // decides how many pictures get drawn.
    // Two generating styles now, and only one of them draws from a character
    // sheet — see `needsCharacterSheet`. The money is the same either way; the
    // sentence is not, and telling a cinematic channel its pictures come from a
    // sheet it has never generated is the kind of copy an operator acts on.
    isGeneratedFootage(footageStyle)
      ? `${illustrationCount(wordCount)} generated illustrations at about ${ILLUSTRATION_USD.toFixed(
          2,
        )} each \u2014 roughly $${(illustrationCount(wordCount) * ILLUSTRATION_USD).toFixed(
          2,
        )} of real money, ${
          needsCharacterSheet(footageStyle)
            ? "drawn from this channel's character sheet and held about twenty seconds each"
            : "in this channel's fixed grade and lens, a different shot each time"
        }.`
      : format === "VERTICAL"
        ? "One stock clip per section, each framed for a 9:16 frame."
        : "One stock clip per section.",
    `Two encoding passes over every frame at ${dimensions}.`,
  ];
}

/**
 * What one illustration costs, in dollars.
 *
 * Measured rather than quoted: `openai/gpt-image-2` reports about 1,150 input
 * and 1,372 output tokens for one 1024x1536 picture conditioned on a character
 * sheet, and the gateway lists $5/M and $30/M for it, which is $0.047. Rounded
 * up, because an estimate an operator reads before spending should not come out
 * under.
 *
 * A constant here and a rate table in `cost.ts`, deliberately: this module is a
 * client component and that one is not the shape a sentence needs. The invoice
 * an operator sees *after* the run is the real per-token figure, summed by
 * `FootageService`; this is the number that has to exist before the first token.
 */
const ILLUSTRATION_USD = 0.05;

/** How many pictures a script this long will be drawn, by the same arithmetic
 *  the collector uses. The section count is not known until the script is
 *  parsed into cues, and `beatCountFor` only needs it as a ceiling — a real
 *  script always has more sections than beats, so the runtime estimate decides. */
function illustrationCount(wordCount: number): number {
  return beatCountFor(estimateSpokenSeconds(wordCount), Number.MAX_SAFE_INTEGER);
}

export function ApproveScriptButton({
  videoId,
  canApprove,
  wordCount,
  characterCount,
  footageStyle,
}: {
  videoId: string;
  /** True only when status is DRAFT and the active version has non-empty content. */
  canApprove: boolean;
  /** The active script version's word count — what the runtime estimate and
   *  the format fit are both computed from. */
  wordCount: number;
  /** The active script version's character count. Narration is billed per
   *  character, so this is the one number in the dialog that is a real invoice
   *  rather than an estimate. */
  characterCount: number;
  /** The channel this video will be collected for. Only the cost lines read
   *  it, and only to say whether the pictures are searched for or paid for. */
  footageStyle: FootageStyle;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<VideoFormat>("LANDSCAPE");
  // Reset every time the dialog closes, deliberately. A format is chosen per
  // video, and a remembered "Short" from the last video is exactly the way an
  // expensive choice gets made by accident.
  const [acknowledged, setAcknowledged] = useState(false);
  const formatFieldId = useId();
  const acknowledgeId = useId();

  const fit = formatFit(format, wordCount);
  // Only a script far past the ceiling has to be acknowledged out loud — see
  // `formatFit` for why the two failures are not the same failure.
  const needsAcknowledgement = fit.verdict === "far-over";
  const blocked = needsAcknowledgement && !acknowledged;

  function onOpenChange(next: boolean) {
    if (isPending) return;

    setOpen(next);

    if (!next) {
      setFormat("LANDSCAPE");
      setAcknowledged(false);
    }
  }

  function onApprove() {
    startTransition(async () => {
      const result = await approveScriptAction(videoId, { format });

      if (!result.ok) {
        toast.error("Could not approve this script", {
          description: result.error.message,
        });
        return;
      }

      setOpen(false);
      setAcknowledged(false);

      // Gate 1 — this is the moment the video becomes eligible for paid
      // downstream steps, so the confirmation has to be unambiguous about
      // which of the two it just committed to.
      toast.success("Script approved", {
        description:
          `The video moved to QUEUED and will render as a ` +
          `${VIDEO_FORMATS[format].label.toLowerCase()} at ${VIDEO_FORMATS[format].dimensions}.`,
      });
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button disabled={!canApprove} size="lg">
          <CircleCheck />
          Approve script
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
          <DialogTitle>Approve and choose the output</DialogTitle>
          <DialogDescription>
            Approving starts narration, footage and the render. This is the only
            moment the shape of the video can be chosen — changing it afterwards
            means paying for the whole pipeline again.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <fieldset className="space-y-2">
            <legend id={`${formatFieldId}-legend`} className="text-sm font-medium">
              What to make
            </legend>
            {/* Radix renders `role="radiogroup"`, which a fieldset's legend
              * does not name on its own — a screen reader would announce an
              * unlabelled group. Same shape as the publish dialog's
              * visibility picker, for the same reason. */}
            <RadioGroup
              aria-labelledby={`${formatFieldId}-legend`}
              value={format}
              onValueChange={(next) => {
                setFormat(next as VideoFormat);
                // A warning acknowledged for one format says nothing about the
                // other, so switching withdraws it.
                setAcknowledged(false);
              }}
              className="gap-2"
              disabled={isPending}
            >
              {FORMAT_ORDER.map((option) => {
                const facts = VIDEO_FORMATS[option];
                const Icon = FORMAT_ICON[option];

                return (
                  <div key={option} className="flex items-start gap-2.5">
                    <RadioGroupItem
                      value={option}
                      id={`${formatFieldId}-${option}`}
                      className="mt-0.5"
                    />
                    <Label
                      htmlFor={`${formatFieldId}-${option}`}
                      className="flex flex-col items-start gap-0.5 font-normal"
                    >
                      <span className="flex items-center gap-1.5 font-medium">
                        <Icon aria-hidden="true" className="size-3.5" />
                        {facts.label}
                        <span className="text-muted-foreground font-normal">
                          {facts.dimensions} · {facts.aspect}
                        </span>
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {facts.summary}
                      </span>
                    </Label>
                  </div>
                );
              })}
            </RadioGroup>
          </fieldset>

          {/* Costs for the SELECTED format only. Both sets side by side would
            * be four lines of numbers to compare when the operator has already
            * made the choice the numbers are about. */}
          <div className="space-y-1.5">
            <p className="text-sm font-medium">What this run spends</p>
            <ul className="text-muted-foreground space-y-1 text-xs">
              {costLines(format, wordCount, characterCount, footageStyle).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>

          {fit.verdict !== "fits" && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>
                This script is {formatRuntime(fit.estimatedSeconds)} long
              </AlertTitle>
              <AlertDescription>
                {/* The honest version of "a 9-minute script cannot become a
                  * 60-second short": nothing here truncates a script, so what
                  * an operator would actually get is a nine-minute vertical
                  * video, which YouTube does not treat as a Short at all. */}
                <p>
                  A Short has to be under{" "}
                  {formatRuntime(VERTICAL_MAX_SECONDS)}. Nothing shortens a
                  script on the way through, so this would render as a{" "}
                  {formatRuntime(fit.estimatedSeconds)} vertical video —
                  YouTube will accept it, but it will not be in the Shorts
                  feed.
                </p>
                <p>
                  {SHORT_FORM_STYLES.length > 0
                    ? `Regenerate the script with a style written for this length — ${SHORT_FORM_STYLES.map(
                        (style) => `“${style.name}” (${style.targetLength})`,
                      ).join(", ")} — or approve this as a full video and cut shorts out of it afterwards.`
                    : "Regenerate with a shorter script first, or approve this as a full video and cut shorts out of it afterwards."}
                </p>
              </AlertDescription>
            </Alert>
          )}

          {needsAcknowledgement && (
            // A switch rather than a second click on the confirm button: the
            // confirm button is where an operator's hand already is, and the
            // whole point of this gate is that it cannot be passed by the
            // motion they were going to make anyway.
            <div className="flex items-start gap-2.5">
              <Switch
                id={acknowledgeId}
                checked={acknowledged}
                onCheckedChange={setAcknowledged}
                disabled={isPending}
              />
              <Label htmlFor={acknowledgeId} className="font-normal">
                I know this will not be a Short, and want to spend the narration
                and the render on it anyway.
              </Label>
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button onClick={onApprove} disabled={isPending || blocked}>
            {isPending ? <Loader2 className="animate-spin" /> : <CircleCheck />}
            Approve as {VIDEO_FORMATS[format].label.toLowerCase()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
