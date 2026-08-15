"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, CircleAlert, ImageOff, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import {
  chooseLogoAction,
  generateLogoOptionAction,
} from "@/actions/channel.action";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Progress } from "@/components/ui/progress";
import { logoFilename, logoImageUrl } from "@/lib/channel-logo";
import { cn } from "@/lib/utils";

/**
 * Three, and no picker offering any other number.
 *
 * Three is enough to see a direction and reject it — one option is a coin
 * toss, two is a comparison with no tiebreak — and each one is a billed image
 * generation, so the number is a spending decision rather than a preference.
 * The owner made it once, here, instead of putting a count field in front of
 * every operator who would then have to guess what it costs.
 */
const OPTION_COUNT = 3;

/**
 * What each option is worth in real money, stated before the click the way the
 * thumbnail dialog states its own and the publish dialog states its quota.
 * Deliberately a count of generations rather than a currency figure: the price
 * depends on `AI_IMAGE_MODEL` and on the gateway account's own rates, and a
 * number in pounds that this app cannot actually check would be worse than the
 * honest unit.
 */
const COST_STATEMENT = `${OPTION_COUNT} image generations, billed to your AI gateway account — one per option.`;

/** One generated option, before it is anybody's logo. */
interface LogoOption {
  /** The full storage path, as `LogoService` returned it. */
  path: string;
}

/**
 * A channel's logo: what it is now, and the batch of options it could become.
 *
 * Not part of the branding form below it, and not saved by the form's Save.
 * Choosing a logo is a single click on a picture and is written immediately by
 * `LogoService.choose`, which is a different kind of edit from typing a hex
 * colour and pressing Save — and holding a chosen logo hostage to a form
 * submit would mean the option strip had to survive a validation failure
 * somewhere else on the page.
 *
 * The options themselves are *not persisted anywhere*. `generateOptions`
 * writes each image to storage and returns its path; only the one that gets
 * chosen is ever recorded, on `ChannelBrand.logoPath`. So a reload loses the
 * unchosen ones, and the card says so rather than letting an operator discover
 * it by navigating away.
 */
export function LogoStudio({
  channelId,
  channelTitle,
  logoPath,
}: {
  channelId: string;
  channelTitle: string;
  /** The chosen logo's storage path, or null for a channel that has none. */
  logoPath: string | null;
}) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [options, setOptions] = useState<LogoOption[]>([]);
  /**
   * How many of the batch have been attempted, not how many succeeded — the
   * progress bar is a report on the work, and a generation that failed is
   * still a generation that took its time and its money.
   */
  const [attempted, setAttempted] = useState(0);
  const [generating, setGenerating] = useState(false);
  /** Set once a whole batch has run, so the "2 of 3 came back" note appears
   *  after the run rather than during it, when it would be describing a batch
   *  that is not finished. */
  const [lastBatchSize, setLastBatchSize] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);

  const failed =
    lastBatchSize !== null && lastBatchSize < OPTION_COUNT ? OPTION_COUNT - lastBatchSize : 0;

  /**
   * One action call per option, in sequence, so the count on screen is a real
   * one. `generateOptions` would produce all three in a single call, but a
   * single call can only say "working" until the last image lands — and each
   * of these takes tens of seconds. Called one at a time, an option appears
   * the moment it exists, and a generation the gateway drops costs the batch
   * one option rather than all of them (the action returns null for a failure,
   * mirroring the service's own "return what you managed" contract).
   *
   * Sequential rather than parallel deliberately: three concurrent image
   * generations against the same gateway account is the shape that gets rate
   * limited, and the progress this exists to show would be meaningless anyway
   * if all three finished at once.
   */
  async function onGenerate() {
    setGenerating(true);
    setConfirmOpen(false);
    setOptions([]);
    setSelected(null);
    setAttempted(0);
    setLastBatchSize(null);

    const generated: LogoOption[] = [];

    for (let index = 0; index < OPTION_COUNT; index += 1) {
      const result = await generateLogoOptionAction(channelId);
      setAttempted(index + 1);

      if (!result.ok) {
        // A rejected action is a session or ownership failure, not a flaky
        // generation — the next two calls would fail identically, so the batch
        // stops rather than spending twice more to prove it.
        toast.error("Could not generate logo options", {
          description: result.error.message,
        });
        break;
      }

      if (result.data) {
        generated.push({ path: result.data });
        setOptions([...generated]);
      }
    }

    setLastBatchSize(generated.length);
    setGenerating(false);

    if (generated.length === 0) {
      toast.error("No logo options came back", {
        description: "Every generation failed. Nothing has been changed.",
      });
      return;
    }

    // Pre-selecting the first one makes "use this" a single click for the
    // common case, and costs nothing for the operator who wants a different
    // one — the selection is inert until they press the button.
    setSelected(generated[0].path);
  }

  async function onChoose() {
    if (!selected) return;

    setChoosing(true);
    const result = await chooseLogoAction({
      channelId,
      filename: logoFilename(selected),
    });
    setChoosing(false);

    if (!result.ok) {
      toast.error("Could not set this logo", {
        description: result.error.message,
      });
      return;
    }

    toast.success(`Logo updated for ${channelTitle}`);
    setOptions([]);
    setSelected(null);
    setLastBatchSize(null);
    router.refresh();
  }

  const busy = generating || choosing;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Logo</CardTitle>
        <CardDescription>
          Composited into the corner of every thumbnail this channel generates.
          It is not the channel avatar — the YouTube Data API has no endpoint
          for that, so download this one and set the avatar by hand, once.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <CurrentLogo channelId={channelId} logoPath={logoPath} />

          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-muted-foreground text-sm">
              {logoPath
                ? "This is the logo on every thumbnail from now on. Generating another set does not replace it until you choose one."
                : "This channel has no logo. Thumbnails are composited without one until it does."}
            </p>

            <GenerateButton
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              hasLogo={Boolean(logoPath)}
              busy={busy}
              onConfirm={onGenerate}
            />
          </div>
        </div>

        {/* The live region, mounted empty and permanent. A region added to the
          * page at the moment it has something to say is a region most screen
          * readers never announce at all — the same defect the pipeline panel
          * and the bulk-action bar document — so it is always here and only
          * its text changes. It speaks per option, which is once every few
          * tens of seconds, rather than per frame of the bar beside it. */}
        <p role="status" aria-atomic="true" className="sr-only">
          {generating
            ? `Generating logo option ${attempted + (attempted < OPTION_COUNT ? 1 : 0)} of ${OPTION_COUNT}.`
            : lastBatchSize !== null
              ? `${lastBatchSize} of ${OPTION_COUNT} logo options generated.`
              : ""}
        </p>

        {generating && (
          <div className="space-y-2">
            <Progress
              value={(attempted / OPTION_COUNT) * 100}
              // Not a live region, and it must not become one: a progressbar's
              // value changes are not announced by design, and the sentence
              // above is the one spoken update on this card.
              aria-label="Logo generation progress"
              aria-valuetext={`${attempted} of ${OPTION_COUNT} options generated`}
            />
            <p className="text-muted-foreground text-xs">
              Option {Math.min(attempted + 1, OPTION_COUNT)} of {OPTION_COUNT} —
              each one takes tens of seconds. Stay on this page; the options are
              not saved anywhere until you choose one.
            </p>
          </div>
        )}

        {options.length > 0 && (
          <div className="space-y-3">
            <fieldset disabled={busy} className="min-w-0">
              <legend className="mb-2 text-sm font-medium">
                {generating
                  ? `${options.length} option${options.length === 1 ? "" : "s"} so far`
                  : "Pick one"}
              </legend>

              <div className="grid grid-cols-3 gap-2 sm:gap-3">
                {options.map((option, index) => {
                  const isSelected = option.path === selected;

                  return (
                    <button
                      key={option.path}
                      type="button"
                      onClick={() => setSelected(option.path)}
                      aria-pressed={isSelected}
                      className={cn(
                        "focus-visible:ring-ring/50 bg-muted relative aspect-square overflow-hidden rounded-lg border-2 outline-none focus-visible:ring-3",
                        // `transition-colors` only — nothing moves, so there is
                        // nothing for reduced motion to suppress.
                        "transition-colors",
                        isSelected
                          ? "border-primary"
                          : "border-transparent hover:border-muted-foreground/30",
                      )}
                    >
                      {/* A plain `<img>`, not `next/image`: the route behind
                        * this src answers only to a request carrying the
                        * operator's session cookie, and the image optimizer
                        * fetches source URLs server-to-server without one. The
                        * thumbnail gallery reaches the same conclusion with
                        * `unoptimized`; a 512px PNG has nothing to optimise. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={logoImageUrl(channelId, option.path)}
                        alt={`Logo option ${index + 1}`}
                        className="size-full object-contain"
                      />

                      {isSelected && (
                        <span className="bg-primary text-primary-foreground absolute top-1 right-1 rounded-full p-0.5">
                          <Check className="size-3" />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {failed > 0 && !generating && (
              <p className="text-muted-foreground flex items-start gap-2 text-xs">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                {options.length} of {OPTION_COUNT} came back — {failed}{" "}
                {failed === 1 ? "generation" : "generations"} failed and{" "}
                {failed === 1 ? "was" : "were"} still billed. Choose one of
                these or generate another set.
              </p>
            )}

            <Button onClick={onChoose} disabled={!selected || busy} size="sm">
              {choosing ? <Loader2 className="animate-spin" /> : <Check />}
              Use this logo
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** The logo as it stands, at the size it is actually composited: square. */
function CurrentLogo({
  channelId,
  logoPath,
}: {
  channelId: string;
  logoPath: string | null;
}) {
  return (
    <div className="bg-muted flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border">
      {logoPath ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoImageUrl(channelId, logoPath)}
          alt="This channel's logo"
          className="size-full object-contain"
        />
      ) : (
        <ImageOff className="text-muted-foreground size-5" aria-hidden="true" />
      )}
    </div>
  );
}

/**
 * The one control on this screen that spends money, and the confirmation that
 * says so before the click rather than after it — the same shape, and the same
 * reasoning, as the thumbnail card's own regenerate dialog.
 *
 * `busy` blocks every route out of the dialog while a batch is in flight, so a
 * second click cannot start a second batch of three.
 */
function GenerateButton({
  open,
  onOpenChange,
  hasLogo,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasLogo: boolean;
  busy: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        onOpenChange(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {busy
            ? "Generating…"
            : hasLogo
              ? `Generate ${OPTION_COUNT} more`
              : `Generate ${OPTION_COUNT} options`}
        </Button>
      </DialogTrigger>

      <DialogContent
        showCloseButton={!busy}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Generate {OPTION_COUNT} logo options</DialogTitle>
          <DialogDescription>
            This costs money every time it runs.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="text-muted-foreground space-y-2 text-sm">
            {/* The cost, before the click. A count of generations rather than
              * a price — see COST_STATEMENT. */}
            <p>{COST_STATEMENT}</p>
            <p>
              The prompt is built from this channel&apos;s name, niche and tone,
              so filling those in below before generating changes what comes
              back.
            </p>
            {hasLogo && (
              <p>
                Nothing is replaced until you pick one. The current logo stays on
                every thumbnail in the meantime.
              </p>
            )}
            <p className="flex items-start gap-2">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              It takes tens of seconds per option and they run one after
              another. Options that are not chosen are not kept — leaving the
              page discards them.
            </p>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {busy ? "Generating…" : "Generate — this spends money"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
