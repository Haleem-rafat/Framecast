"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  BookOpen,
  Camera,
  Clapperboard,
  Layers,
  PenLine,
  Play,
  Smile,
  Square,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";

import { FormField } from "@/components/shared/form-field";
import { useVoiceList, VoiceListNotice } from "@/components/shared/voice-picker";
import { ChoiceCard, ChoiceGroup } from "@/components/shared/wizard/choice-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { FootageStyle } from "@/generated/prisma/enums";
import { ART_STYLES, findArtStyle, type ArtStyleId } from "@/lib/art-styles";
import { DOODLE_BEAT_MAX_SECONDS, DOODLE_BEAT_MIN_SECONDS } from "@/lib/doodle-cadence";
import {
  FOOTAGE_STYLES,
  needsCharacterSheet,
  stylePicksArtStyle,
} from "@/lib/footage-styles";
import { findStylePreset } from "@/lib/style-presets";
import type { CaptionMode } from "@/lib/video-style";
import { cn } from "@/lib/utils";

import type { StepProps } from "./show-steps";
import { displayedCaptionMode, type BrandDraft } from "./series-wizard-state";

/** Writes one field of the brand draft. Every step below edits the channel's
 *  settings through this and nothing else. */
function brandUpdater(update: StepProps["update"]) {
  return (patch: Partial<BrandDraft>) =>
    update((current) =>
      current.brand ? { ...current, brand: { ...current.brand, ...patch } } : current,
    );
}

/** The radio value standing for "the deployment's default voice", because a
 *  radio value has to be a string and `voiceId` is `string | null`. The same
 *  sentinel the branding screen uses. */
const DEFAULT_VOICE = "__default__";

/**
 * Step 4: who narrates.
 *
 * The same list the branding screen shows — fetched from the operator's own
 * ElevenLabs account, never a hardcoded set — laid out as cards with a ▶ on
 * each voice that has a sample. A voice with no sample gets no button rather
 * than a button that plays nothing.
 */
export function VoiceStep({ draft, update, headingId }: StepProps) {
  const { voices, status } = useVoiceList();
  const setBrand = brandUpdater(update);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const brand = draft.brand;

  // Stop a sample on the way out, so leaving the step does not leave a voice
  // talking over the next one.
  useEffect(() => () => audio.current?.pause(), []);

  if (!brand) {
    return null;
  }

  function preview(voiceId: string, url: string) {
    const element = audio.current ?? new Audio();
    audio.current = element;

    if (playing === voiceId) {
      element.pause();
      setPlaying(null);
      return;
    }

    setPreviewFailed(false);
    element.src = url;
    element.onended = () => setPlaying(null);
    element.play().then(
      () => setPlaying(voiceId),
      () => {
        setPlaying(null);
        setPreviewFailed(true);
      },
    );
  }

  const value = brand.voiceId ?? DEFAULT_VOICE;
  const unlisted =
    brand.voiceId && !voices.some((voice) => voice.voiceId === brand.voiceId)
      ? brand.voiceId
      : null;

  return (
    <div className="space-y-3">
      <VoiceListNotice status={status} voiceCount={voices.length} />

      {previewFailed && (
        <p className="text-muted-foreground text-xs">
          That sample could not be played. The voice itself is unaffected — only
          the preview is.
        </p>
      )}

      <ChoiceGroup
        name="voice"
        value={value}
        onChange={(next) =>
          setBrand(
            next === DEFAULT_VOICE
              ? { voiceId: null, voiceName: null }
              : {
                  voiceId: next,
                  // A name has to come from the list; an unlisted saved voice
                  // keeps the name it was saved with.
                  voiceName:
                    voices.find((voice) => voice.voiceId === next)?.name ??
                    (next === brand.voiceId ? brand.voiceName : null),
                },
          )
        }
        labelledBy={headingId}
      >
        <ChoiceCard
          value={DEFAULT_VOICE}
          title="Default voice"
          description="Whatever voice this deployment is configured with — what every channel narrated in before voices could be chosen."
        />

        {unlisted && (
          <ChoiceCard
            value={unlisted}
            title={brand.voiceName ?? "Saved voice"}
            description="Saved on this channel, but not in the list your account returned. It is still what narration uses."
          />
        )}

        {voices.map((voice) => (
          <ChoiceCard
            key={voice.voiceId}
            value={voice.voiceId}
            title={voice.name}
            badge={voice.labels.slice(0, 3).map((label) => (
              <Badge key={label.name} variant="secondary" className="font-normal">
                {label.value}
              </Badge>
            ))}
            description={voice.description ?? undefined}
            aside={
              voice.previewUrl ? (
                <Button
                  type="button"
                  variant="outline"
                  size="icon-lg"
                  onClick={() => preview(voice.voiceId, voice.previewUrl!)}
                  aria-label={
                    playing === voice.voiceId
                      ? `Stop the sample of ${voice.name}`
                      : `Play a sample of ${voice.name}`
                  }
                >
                  {playing === voice.voiceId ? <Square /> : <Play />}
                </Button>
              ) : undefined
            }
          />
        ))}
      </ChoiceGroup>
    </div>
  );
}

/**
 * Mood cards for the music step. Each sets the channel's Jamendo search, and
 * each query is one or two words on purpose: Jamendo matches *every* word, so
 * a longer phrase finds fewer tracks rather than better ones — the rule the
 * branding screen's music card spells out.
 *
 * The swatches are the app's own brand tokens, not a palette of their own, so
 * they follow the theme in dark mode.
 */
const MUSIC_MOODS: readonly {
  id: string;
  title: string;
  mood: string;
  query: string;
  swatch: string;
}[] = [
  {
    id: "epic",
    title: "Epic orchestral",
    mood: "Big strings and drums for sweeping stories",
    query: "epic orchestral",
    swatch: "from-brand-violet to-brand-blue",
  },
  {
    id: "dark",
    title: "Dark ambient",
    mood: "Low, uneasy textures for mysteries",
    query: "dark ambient",
    swatch: "from-brand-violet to-foreground",
  },
  {
    id: "suspense",
    title: "Suspense",
    mood: "Slow build and tension for reveals",
    query: "suspense",
    swatch: "from-brand-amber to-brand-violet",
  },
  {
    id: "calm",
    title: "Calm ambient",
    mood: "Unobtrusive pads that sit under any narration",
    query: "calm ambient",
    swatch: "from-brand-cyan to-brand-blue",
  },
  {
    id: "piano",
    title: "Soft piano",
    mood: "Gentle and reflective, for biography and history",
    query: "soft piano",
    swatch: "from-brand-blue to-brand-cyan",
  },
  {
    id: "lofi",
    title: "Lo-fi",
    mood: "Relaxed beats for explainers and money topics",
    query: "lofi",
    swatch: "from-brand-amber to-brand-cyan",
  },
];

/** What `BrandService.resolve` searches for when the channel has no query.
 *  Repeated from the branding screen for the same client/server split. */
const MUSIC_FALLBACK = "calm ambient instrumental";

/**
 * Step 5 (optional): the channel's music bed.
 *
 * No ▶ here, deliberately. Music is searched on Jamendo when each video
 * renders, so there is no one track behind a mood to play — a preview would be
 * a sample of something the video may never use.
 */
export function MusicStep({
  draft,
  update,
  headingId,
  savedQuery,
}: StepProps & { savedQuery: string | null }) {
  const setBrand = brandUpdater(update);
  const query = draft.brand?.musicQuery ?? null;
  const mood = MUSIC_MOODS.find((entry) => entry.query === query) ?? null;

  if (!draft.brand) {
    return null;
  }

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">
        Now searching for{" "}
        <span className="text-foreground font-medium">
          &ldquo;{savedQuery ?? MUSIC_FALLBACK}&rdquo;
        </span>
        {savedQuery ? "" : " (the default)"}. Tracks are picked from Jamendo when
        each video renders, so there is no single song to preview — and a search
        that finds nothing renders without music rather than failing.
      </p>

      <Tabs defaultValue={query && !mood ? "custom" : "moods"}>
        <TabsList variant="line" className="border-b">
          <TabsTrigger value="moods">Moods</TabsTrigger>
          <TabsTrigger value="custom">Custom</TabsTrigger>
        </TabsList>

        <TabsContent value="moods" className="pt-3">
          <ChoiceGroup
            name="music"
            value={mood?.id ?? null}
            onChange={(id) => {
              const next = MUSIC_MOODS.find((entry) => entry.id === id);
              if (next) setBrand({ musicQuery: next.query });
            }}
            labelledBy={headingId}
          >
            {MUSIC_MOODS.map((entry) => (
              <ChoiceCard
                key={entry.id}
                value={entry.id}
                title={entry.title}
                description={entry.mood}
                media={
                  <span
                    aria-hidden="true"
                    className={cn("block size-10 rounded-lg bg-gradient-to-br", entry.swatch)}
                  />
                }
              />
            ))}
          </ChoiceGroup>
        </TabsContent>

        <TabsContent value="custom" className="pt-3">
          <FormField
            name="musicQuery"
            label="Search for"
            description={`One or two words describing the music, not the channel — “lullaby”, “ambient”, “soft piano”. Leave it empty to fall back to “${MUSIC_FALLBACK}”.`}
          >
            {(control) => (
              <Input
                value={query ?? ""}
                onChange={(event) =>
                  setBrand({ musicQuery: event.target.value.trim() ? event.target.value : null })
                }
                placeholder={MUSIC_FALLBACK}
                maxLength={160}
                {...control}
              />
            )}
          </FormField>
        </TabsContent>
      </Tabs>
    </div>
  );
}

const FOOTAGE_ICON: Record<FootageStyle, LucideIcon> = {
  LIVE_ACTION: Clapperboard,
  CARTOON: Smile,
  ILLUSTRATED: BookOpen,
  CINEMATIC: Camera,
  MIXED: Layers,
  DOODLE: PenLine,
};

/** A tall card's picture: a real sample where the repo ships one, and a
 *  gradient with the style's icon where it does not. Footage styles have no
 *  samples on purpose — live action is filmed stock and mixed is both, so one
 *  still would misrepresent them (see `StylePicker`). */
function TallMedia({ src, icon: Icon }: { src?: string; icon?: LucideIcon }) {
  const [failed, setFailed] = useState(false);

  return (
    <span className="from-primary/25 via-muted to-brand-cyan/20 relative flex aspect-[3/4] w-full items-center justify-center bg-gradient-to-br">
      {src && !failed ? (
        <Image
          src={src}
          alt=""
          fill
          sizes="10rem"
          className="object-cover"
          onError={() => setFailed(true)}
        />
      ) : Icon ? (
        <Icon aria-hidden="true" className="text-primary/70 size-8" />
      ) : null}
    </span>
  );
}

/** A horizontal, snap-scrolling row: wide screens see every card, a phone
 *  swipes through them instead of scrolling past a page of tall cards. */
function CardRow({ children }: { children: ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 py-1.5 sm:-mx-1.5 sm:px-1.5">
      {children}
    </div>
  );
}

const TALL_GROUP = "flex w-max snap-x gap-3";
const TALL_CARD = "w-36 shrink-0 snap-start sm:w-40";

/**
 * Step 6: what the pictures look like.
 *
 * The footage style is the decision; the art style and the doodle rhythm are
 * follow-ups that exist only for the styles that read them, and appear under
 * it rather than as steps of their own so the step count never changes under
 * the operator's feet.
 */
export function LookStep({
  draft,
  update,
  headingId,
  channelTitle,
  hasCharacterSheet,
  stylePreset,
}: StepProps & {
  channelTitle: string;
  hasCharacterSheet: boolean;
  stylePreset: string | null;
}) {
  const setBrand = brandUpdater(update);
  const brand = draft.brand;

  if (!brand) {
    return null;
  }

  const footage = FOOTAGE_STYLES.find((option) => option.value === brand.footageStyle);
  const art = findArtStyle(brand.artStyle);
  const preset = findStylePreset(stylePreset);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <CardRow>
          <ChoiceGroup
            name="footage-style"
            value={brand.footageStyle}
            onChange={(value) => setBrand({ footageStyle: value as FootageStyle })}
            labelledBy={headingId}
            className={TALL_GROUP}
          >
            {FOOTAGE_STYLES.map((option) => (
              <ChoiceCard
                key={option.value}
                value={option.value}
                layout="tall"
                className={TALL_CARD}
                media={<TallMedia icon={FOOTAGE_ICON[option.value]} />}
                title={option.label}
              />
            ))}
          </ChoiceGroup>
        </CardRow>
        {footage && <p className="text-muted-foreground text-xs">{footage.description}</p>}
      </div>

      {stylePicksArtStyle(brand.footageStyle) && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium">Drawn in</h3>
          <CardRow>
            <ChoiceGroup
              name="art-style"
              value={brand.artStyle}
              onChange={(value) => setBrand({ artStyle: value as ArtStyleId })}
              label="Art style"
              className={TALL_GROUP}
            >
              {ART_STYLES.map((option) => (
                <ChoiceCard
                  key={option.id}
                  value={option.id}
                  layout="tall"
                  className={TALL_CARD}
                  media={<TallMedia src={`/art-styles/${option.id}.webp`} icon={PenLine} />}
                  title={option.name}
                />
              ))}
            </ChoiceGroup>
          </CardRow>
          <p className="text-muted-foreground text-xs">
            {art?.description ??
              "There is no default look — a default would give every channel the same one — so pick the style every picture on this channel is drawn in."}
          </p>
        </div>
      )}

      {brand.footageStyle === "DOODLE" && (
        <FormField
          name="beatSeconds"
          label="Seconds per picture"
          description={`How long one drawing holds the screen, ${DOODLE_BEAT_MIN_SECONDS}–${DOODLE_BEAT_MAX_SECONDS}. Faster cutting is most of this format's feel, and every picture is drawn, so it is also what it costs.`}
        >
          {(control) => (
            <Input
              {...control}
              type="number"
              inputMode="numeric"
              min={DOODLE_BEAT_MIN_SECONDS}
              max={DOODLE_BEAT_MAX_SECONDS}
              step={1}
              className="w-full sm:w-32"
              value={brand.beatSeconds ?? ""}
              onChange={(event) =>
                setBrand({
                  beatSeconds: event.target.value === "" ? null : Number(event.target.value),
                })
              }
            />
          )}
        </FormField>
      )}

      {/* A notice, not a block: the sheet is generated on the branding screen
          and costs money, which is not a thing to do from inside a form. The
          series can be created now; its illustrated episodes refuse to
          collect footage until the sheet exists, and say so. */}
      {needsCharacterSheet(brand.footageStyle) && !hasCharacterSheet && (
        <Alert>
          <TriangleAlert />
          <AlertTitle>{channelTitle} needs a character sheet</AlertTitle>
          <AlertDescription>
            <p>
              Illustrated videos draw every picture from the channel&apos;s
              character sheet, and this channel does not have one yet. Describe the
              character and generate the sheet before the first episode runs.
            </p>
            <Link
              href={`/channels/${draft.channelId}`}
              className="text-primary underline-offset-4 hover:underline"
            >
              Open {channelTitle}&apos;s branding
            </Link>
          </AlertDescription>
        </Alert>
      )}

      {preset && (
        <p className="text-muted-foreground text-xs">
          This channel is set to the &ldquo;{preset.name}&rdquo; look, whose render
          settings still sit underneath whatever you pick here. Change it on the
          channel&apos;s branding screen.
        </p>
      )}
    </div>
  );
}

const SAMPLE_LINES = [
  "In 1919 a tank of molasses burst in Boston",
  "and a wave of syrup swept through the streets",
  "at thirty-five miles an hour.",
];

/** The kinetic preview's words, in the one-to-three-word groups the renderer
 *  lands them in, with the stressed word marked. */
const SAMPLE_BEATS: { words: string; stress?: string }[] = [
  { words: "In 1919", stress: "1919" },
  { words: "a tank of" },
  { words: "molasses", stress: "molasses" },
  { words: "burst", stress: "burst" },
  { words: "in Boston" },
];

/** Ticks through `length` frames, or stays on the first when the operator
 *  asked for reduced motion — the preview is a description, not decoration. */
function useTicker(length: number, intervalMs: number): number {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    const timer = window.setInterval(
      () => setIndex((current) => (current + 1) % length),
      intervalMs,
    );

    return () => window.clearInterval(timer);
  }, [length, intervalMs]);

  return index;
}

/** A frame-shaped dark panel standing in for the video behind the captions. */
function CaptionFrame({
  vertical,
  children,
}: {
  vertical: boolean;
  children: ReactNode;
}) {
  return (
    <span className="bg-muted/60 flex h-44 w-full items-center justify-center rounded-lg">
      <span
        className={cn(
          // Dark in both themes: this stands for a video frame, not for the
          // page, and captions are drawn to be read over footage.
          "relative flex h-full overflow-hidden rounded-md bg-gradient-to-b from-neutral-600 to-neutral-950",
          vertical ? "aspect-[9/16]" : "aspect-video max-w-full",
        )}
      >
        {children}
      </span>
    </span>
  );
}

function LinePreview({ vertical }: { vertical: boolean }) {
  const index = useTicker(SAMPLE_LINES.length, 2200);

  return (
    <CaptionFrame vertical={vertical}>
      <span className="absolute inset-x-2 text-white bottom-3 text-center text-[11px] leading-tight font-medium [text-shadow:0_1px_2px_rgb(0_0_0/0.9)]">
        {SAMPLE_LINES[index]}
      </span>
    </CaptionFrame>
  );
}

function WordPreview({ vertical }: { vertical: boolean }) {
  const index = useTicker(SAMPLE_BEATS.length, 700);
  const beat = SAMPLE_BEATS[index];

  return (
    <CaptionFrame vertical={vertical}>
      <span className="absolute inset-0 flex items-center justify-center px-2 text-center text-lg font-extrabold tracking-tight uppercase [text-shadow:0_2px_3px_rgb(0_0_0/0.9)]">
        {beat.words.split(" ").map((word, position) => (
          <span
            key={`${index}-${position}`}
            className={cn(
              "mx-0.5",
              word === beat.stress ? "text-brand-amber" : "text-white",
            )}
          >
            {word}
          </span>
        ))}
      </span>
    </CaptionFrame>
  );
}

/**
 * Step 7: how captions look.
 *
 * Two tiles because the renderer has exactly two modes (`srt` and `kinetic`);
 * anything more would be a style the video cannot come out in. The previews
 * are CSS, drawn in the frame shape chosen on the channel step, and the
 * stressed word is amber because that is the colour the kinetic renderer uses.
 */
export function CaptionsStep({ draft, update, context, headingId }: StepProps) {
  const setBrand = brandUpdater(update);
  const value = displayedCaptionMode(draft, context);
  const vertical = draft.format === "VERTICAL";

  if (!draft.brand) {
    return null;
  }

  return (
    <div className="space-y-3">
      <ChoiceGroup
        name="caption-mode"
        value={value}
        onChange={(mode) => setBrand({ captionMode: mode as CaptionMode })}
        labelledBy={headingId}
        className="sm:grid-cols-2"
      >
        <ChoiceCard
          value="srt"
          layout="tile"
          media={<LinePreview vertical={vertical} />}
          title="Line at a time"
          description="A whole line appears and is read in one glance. Suits long videos watched on a laptop."
        />
        <ChoiceCard
          value="kinetic"
          layout="tile"
          media={<WordPreview vertical={vertical} />}
          title="Word by word"
          description="One to three words land as each is spoken, with the stressed word coloured. Suits Shorts held at arm's length."
        />
      </ChoiceGroup>

      {draft.brand.captionMode === null && (
        <p className="text-muted-foreground text-xs">
          Selected because it is what this channel&apos;s look already uses. Pick the
          other to change it.
        </p>
      )}
    </div>
  );
}
