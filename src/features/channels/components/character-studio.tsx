"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CircleAlert, Loader2, Sparkles, UserRoundX } from "lucide-react";
import { toast } from "sonner";

import { generateCharacterSheetAction } from "@/actions/channel.action";
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
import { findArtStyle } from "@/lib/art-styles";
import { characterSheetUrl } from "@/lib/character-sheet";
import type { FootageStyle } from "@/generated/prisma/enums";
import { isGeneratedFootage } from "@/lib/footage-styles";

/**
 * One generation, stated before the click the way the logo card states its
 * own. A figure rather than a count of generations — unlike a logo, this model
 * is pinned (`AI_ILLUSTRATION_MODEL` defaults to `openai/gpt-image-2`) and its
 * gateway rate is known, so the honest unit here is money.
 */
const COST_STATEMENT =
  "One image generation — about $0.05, billed to your AI gateway account.";

/**
 * A channel's recurring character: the reference sheet every illustration is
 * drawn from.
 *
 * Sits beside the logo card and behaves almost identically, with one
 * deliberate difference. A logo is chosen from three candidates because it is a
 * taste decision between equally valid marks. A character sheet is the
 * channel's protagonist — there is only one of it, and the question is "is this
 * right, or draw another". So generating persists immediately and the card
 * shows what the channel has, with no unsaved state to lose by navigating away.
 *
 * Shown for every channel rather than only illustrated ones, because a channel
 * cannot sensibly choose "Illustrated story" in the form below and then be told
 * a control it needs is hidden until it saves. It states plainly when the sheet
 * is not being used.
 */
export function CharacterStudio({
  channelId,
  channelTitle,
  footageStyle,
  characterBrief,
  characterSheetPath,
  artStyle,
}: {
  channelId: string;
  channelTitle: string;
  /** As saved, not as the form currently holds it — this card is outside the
   *  form, and what matters is what videos will actually collect. */
  footageStyle: FootageStyle;
  characterBrief: string | null;
  characterSheetPath: string | null;
  /** As saved. The sheet is the sample of this look — see the card copy. */
  artStyle: string | null;
}) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [generating, setGenerating] = useState(false);

  const used = isGeneratedFootage(footageStyle);
  const hasBrief = Boolean(characterBrief?.trim());
  const style = findArtStyle(artStyle);
  const ready = hasBrief && style !== null;

  async function onGenerate() {
    setGenerating(true);
    setConfirmOpen(false);

    const result = await generateCharacterSheetAction(channelId);
    setGenerating(false);

    if (!result.ok) {
      toast.error("Could not draw a character sheet", {
        description: result.error.message,
      });
      return;
    }

    toast.success(`Character sheet updated for ${channelTitle}`, {
      description: `Spent $${result.data.costUsd.toFixed(2)}. Every illustration from now on is drawn from it.`,
    });
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Character sheet</CardTitle>
        <CardDescription>
          The one picture every illustration is drawn from, so the same
          character appears in the first scene and the fortieth. Generated once
          and reused by every video this channel makes — and drawn in the
          channel&apos;s art style, so it doubles as the sample of what that
          look actually produces.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="bg-muted flex size-32 shrink-0 items-center justify-center overflow-hidden rounded-lg border">
            {characterSheetPath ? (
              // A plain `<img>`, not `next/image`: the route behind this src
              // answers only to a request carrying the operator's session
              // cookie, and the image optimizer fetches source URLs
              // server-to-server without one. Same conclusion the logo card and
              // the thumbnail gallery reach.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={characterSheetUrl(channelId, characterSheetPath)}
                alt={`The recurring character on ${channelTitle}`}
                className="size-full object-contain"
              />
            ) : (
              <UserRoundX
                className="text-muted-foreground size-6"
                aria-hidden="true"
              />
            )}
          </div>

          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-muted-foreground text-sm">
              {!hasBrief
                ? "Describe the recurring character below and save, then generate. Nothing can be drawn without that description — it is the only thing that stops each picture inventing a different character."
                : !style
                  ? "Pick an art style below and save, then generate. The sheet is drawn in that style and so is every scene after it, so there is nothing to draw until one is chosen."
                  : characterSheetPath
                    ? `Every illustration is drawn from this sheet, in ${style.name}. Generating another replaces it for future videos; videos already collected keep the pictures they have.`
                    : `The character is described and the style is ${style.name}, but nothing is drawn yet. Generate the sheet before collecting footage for an illustrated video.`}
            </p>

            {used && !characterSheetPath && (
              <p className="text-muted-foreground flex items-start gap-2 text-xs">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                This channel is set to illustrated footage, so collection will
                refuse until a sheet exists.
              </p>
            )}

            {!used && characterSheetPath && (
              <p className="text-muted-foreground text-xs">
                Not in use — this channel&apos;s footage style is not
                &ldquo;Illustrated story&rdquo;.
              </p>
            )}

            <GenerateButton
              open={confirmOpen}
              onOpenChange={setConfirmOpen}
              hasSheet={Boolean(characterSheetPath)}
              disabled={!ready}
              busy={generating}
              onConfirm={onGenerate}
            />
          </div>
        </div>

        {/* Mounted empty and permanent. A region added to the page at the
          * moment it has something to say is one most screen readers never
          * announce at all — the same defect the logo card documents. */}
        <p role="status" aria-atomic="true" className="sr-only">
          {generating ? "Drawing the character sheet." : ""}
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * The control that spends money, and the confirmation that says so before the
 * click — the same shape and the same reasoning as the logo card's.
 */
function GenerateButton({
  open,
  onOpenChange,
  hasSheet,
  disabled,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasSheet: boolean;
  disabled: boolean;
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
        <Button variant="outline" size="sm" disabled={busy || disabled}>
          {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {busy ? "Drawing…" : hasSheet ? "Draw a new sheet" : "Draw the character sheet"}
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
          <DialogTitle>Draw this channel&apos;s character sheet</DialogTitle>
          <DialogDescription>This costs money every time it runs.</DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="text-muted-foreground space-y-2 text-sm">
            <p>{COST_STATEMENT}</p>
            <p>
              The prompt is the character description and the art style saved
              below, plus this channel&apos;s niche and tone. Save any edits
              first — this draws from what is stored, not from what is on
              screen.
            </p>
            <p>
              This is also the only sample of the art style you get, and it is
              deliberately the only one: six samples on every page load would be
              six generations an operator never asked for. One picture of your
              own character in your own style says more than six of somebody
              else&apos;s anyway.
            </p>
            {hasSheet && (
              <p>
                Replacing the sheet changes only future videos. Anything already
                collected keeps the pictures it has, and they will not match the
                new character.
              </p>
            )}
            <p className="flex items-start gap-2">
              <CircleAlert className="mt-0.5 size-4 shrink-0" />
              It takes tens of seconds. Look at the result before making a
              video — this one picture decides what every scene looks like.
            </p>
          </div>
        </DialogBody>

        <DialogFooter>
          <Button onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {busy ? "Drawing…" : "Draw — this spends money"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
