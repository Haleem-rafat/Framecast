"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { ExternalLink, Loader2, TriangleAlert } from "lucide-react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";

import {
  listVideoCategoriesAction,
  updateBrandingAction,
} from "@/actions/channel.action";
import { FormField } from "@/components/shared/form-field";
import { Reveal } from "@/components/shared/reveal";
import { VoicePicker } from "@/components/shared/voice-picker";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FieldError, FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ART_STYLES, findArtStyle } from "@/lib/art-styles";
import { BRAND_FONTS } from "@/lib/brand-fonts";
import { FOOTAGE_STYLES } from "@/lib/footage-styles";
import {
  MADE_FOR_KIDS_CONSEQUENCES,
  MADE_FOR_KIDS_GUIDANCE_URL,
  MADE_FOR_KIDS_QUESTION,
  MADE_FOR_KIDS_TEST,
} from "@/lib/youtube-audience";
import {
  CURATED_CATEGORIES,
  type VideoCategory,
} from "@/lib/youtube-categories";
import {
  brandingFormSchema,
  type BrandingFormOutput,
  type BrandingFormValues,
} from "@/schemas/channel.schema";
import type { ChannelBranding } from "@/services/brand.service";
import { HeadlinePreview } from "@/features/channels/components/headline-preview";

/**
 * What `BrandService.resolve` hands a render for a channel that has never
 * chosen one, shown as placeholder text so an operator can see the value that
 * is actually in force without it appearing to be something they typed.
 *
 * Repeated here rather than imported because `brand.service.ts` is
 * `server-only` and this is a client component — the same split
 * `youtube-categories.ts` exists for. They have to agree, and the service test
 * asserts the service's side.
 */
const FALLBACK_PLACEHOLDERS = {
  tone: "clear and factual",
  niche: "general interest",
  musicQuery: "calm ambient instrumental",
} as const;

/**
 * The stored brand as the controls hold it: every field a string, with the
 * three nullable ones flattened to `""` so an unset field is an empty box
 * showing its placeholder rather than the word "null".
 */
function toDefaultValues(branding: ChannelBranding): BrandingFormValues {
  return {
    primaryColour: branding.primaryColour,
    secondaryColour: branding.secondaryColour,
    // A row written before this picker existed, or by hand, can name a face
    // that is not on the list. Falling back keeps the select from rendering
    // blank — the same coercion `SettingsForm.toDefaultValues` does, and for
    // the same reason.
    headlineFont:
      BRAND_FONTS.find((font) => font.value === branding.headlineFont)?.value ??
      BRAND_FONTS[0].value,
    tone: branding.tone ?? "",
    niche: branding.niche ?? "",
    musicQuery: branding.musicQuery ?? "",
    language: branding.language,
    categoryId: branding.categoryId,
    madeForKids: branding.madeForKids,
    footageStyle: branding.footageStyle,
    characterBrief: branding.characterBrief ?? "",
    // `""` rather than null, so the picker's "no style chosen" option is a
    // real selectable value — a `Select` value has to be a string. The schema
    // coerces it back to null on the way out.
    artStyle: branding.artStyle ?? "",
    // Null rather than "" — unlike tone and niche, "no voice chosen" is a real
    // selectable option in the picker rather than an empty box, and the schema
    // round-trips null through unchanged.
    voiceId: branding.voiceId,
    voiceName: branding.voiceName,
  };
}

/**
 * The radio value standing for "no voice chosen", because a `RadioGroup` value
 * has to be a string and the field it drives is `string | null`. The same
 * sentinel `SettingsForm` uses for its unpinned script template, and for the
 * same reason.
 */
const DEFAULT_VOICE = "__default__";

/**
 * Everything about a channel except its logo, in the four groups the data
 * itself divides into: what it looks like, how it is written, what it sounds
 * like, and what it tells YouTube.
 *
 * One form and one Save across all four, the way the settings page works.
 * These are settings, not a wizard: nothing here is sequenced, an operator
 * arrives to change one field and leaves, and four separate save buttons on
 * one screen would make "did that save?" a question worth asking. Save is
 * disabled until something is dirty and a Discard appears beside it when
 * something is, so the state of the page is legible without pressing anything.
 *
 * The publishing four used to live in a dialog off the channels list. They are
 * here now because they are the same kind of thing as the rest — per-channel
 * facts that every video inherits — and because the audience declaration and
 * the footage style are the pair most likely to be wrong together on a
 * children's channel. Their wording, their links and their consequence text
 * come from `youtube-audience.ts` unchanged: it exists so the two screens that
 * mention a COPPA declaration cannot drift, and folding the dialog in here
 * does not make this the place to start paraphrasing it.
 */
export function BrandingForm({
  channelId,
  channelTitle,
  branding,
}: {
  channelId: string;
  channelTitle: string;
  branding: ChannelBranding;
}) {
  const router = useRouter();
  const audienceId = useId();

  /**
   * Starts as the curated list so the select is usable on the very first
   * frame — before the fetch resolves, and if it never does. `live` says which
   * of the two the operator is currently looking at, because "these are the
   * categories YouTube accepts" and "these are the categories YouTube accepted
   * for a US channel when this was written" are not the same claim.
   */
  const [categories, setCategories] = useState<readonly VideoCategory[]>(
    CURATED_CATEGORIES,
  );
  const [live, setLive] = useState<boolean | null>(null);
  const [loadingCategories, setLoadingCategories] = useState(false);

  /**
   * What is currently in the database, as the last write reported it — which
   * is what Discard has to go back to, and it is not always the `branding`
   * prop. A successful save is followed by `router.refresh()`, and until that
   * round trip lands the prop still describes the row as it was *before* the
   * save; a Discard pressed in that window would silently undo a save the
   * operator had just been told succeeded.
   *
   * Not synced from the prop afterwards, deliberately. The prop only ever
   * changes because of a refresh this component asked for, and an effect that
   * copied it back in would fight the very state it is meant to settle.
   */
  const [saved, setSaved] = useState(branding);

  const {
    register,
    control,
    handleSubmit,
    reset,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<BrandingFormValues, unknown, BrandingFormOutput>({
    resolver: zodResolver(brandingFormSchema),
    defaultValues: toDefaultValues(branding),
  });

  /** Watched rather than read from `branding`, so choosing "Illustrated story"
   *  reveals the character field immediately instead of only after a save. */
  const footageStyle = useWatch({ control, name: "footageStyle" });

  /**
   * Two YouTube round trips, so they happen once when the screen mounts rather
   * than on every render. The action cannot fail for a reachability reason
   * (`listCategories` degrades to the curated list itself), so a rejected
   * result here means the session check failed and the curated list already on
   * screen is the right thing to leave up.
   */
  useEffect(() => {
    let cancelled = false;

    async function loadCategories() {
      setLoadingCategories(true);
      const result = await listVideoCategoriesAction(channelId);

      if (cancelled) return;

      setLoadingCategories(false);

      if (!result.ok) {
        setLive(false);
        return;
      }

      setCategories(result.data.categories);
      setLive(result.data.live);
    }

    void loadCategories();

    return () => {
      cancelled = true;
    };
  }, [channelId]);

  async function onSubmit(values: BrandingFormOutput) {
    const result = await updateBrandingAction({ channelId, ...values });

    if (!result.ok) {
      toast.error("Could not save this channel's branding", {
        description: result.error.message,
      });
      return;
    }

    toast.success(`Saved ${channelTitle}`);

    /**
     * Reset to what the server says it stored, not to what was on screen.
     *
     * Two things ride on the difference. It is what actually clears
     * `isDirty` — `reset(undefined, { keepValues: true })` looks like it
     * should, and does not: with no values passed, react-hook-form leaves
     * `_defaultValues` exactly as it was, and `isDirty` is computed against
     * those, so the form stays dirty and Save stays enabled after a
     * successful save. (Measured in the browser against react-hook-form
     * 7.85 — the button was still live and Discard still showing.)
     *
     * And it is honest about what was written. The schema trims, and turns an
     * emptied box into a null the render falls back from, so a tone typed
     * with a trailing space or cleared entirely comes back looking slightly
     * different from what was typed. Showing the stored value is how the
     * operator finds that out now rather than on the next reload.
     */
    setSaved(result.data);
    reset(toDefaultValues(result.data));

    // Still refreshed: the "Last saved" footnote below this form and the
    // summary line on every channel card are server-rendered from the same
    // row.
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-6">
      <LookCard control={control} register={register} errors={errors} />

      <Reveal>
        <WritingCard register={register} errors={errors} />
      </Reveal>

      <Reveal>
        <NarrationCard control={control} setValue={setValue} errors={errors} />
      </Reveal>

      <Reveal>
        <MusicCard register={register} errors={errors} />
      </Reveal>

      <Reveal>
        <Card>
          <CardHeader>
            <CardTitle>Publishing defaults</CardTitle>
            <CardDescription>
              What every upload from {channelTitle} tells YouTube about itself —
              the language and category that decide who it is shown to, the
              audience declaration that decides what YouTube allows on it, and
              the kind of footage the pipeline goes looking for.
            </CardDescription>
          </CardHeader>

          <CardContent>
            <FieldGroup>
              <FormField
                name="language"
                label="Language"
                description="A BCP-47 tag — en, en-GB, pt-BR. Sent as both the metadata language and the spoken language, which are the same here: the description is built from the script the voice reads."
                error={errors.language?.message}
              >
                {(controlProps) => (
                  <Input
                    placeholder="en"
                    autoComplete="off"
                    className="w-full sm:w-64"
                    {...register("language")}
                    {...controlProps}
                  />
                )}
              </FormField>

              <Controller
                control={control}
                name="categoryId"
                render={({ field }) => (
                  <FormField
                    name="categoryId"
                    label="Category"
                    description={
                      loadingCategories
                        ? "Loading the categories YouTube accepts for this channel…"
                        : "Only categories YouTube marks as assignable are listed — anything else is rejected after the whole file has uploaded."
                    }
                    error={errors.categoryId?.message}
                  >
                    {(controlProps) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger {...controlProps} className="w-full sm:w-64">
                          <SelectValue placeholder="Pick a category" />
                        </SelectTrigger>
                        <SelectContent>
                          {categories.map((category) => (
                            <SelectItem key={category.id} value={category.id}>
                              {category.title}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </FormField>
                )}
              />

              {live === false && (
                <p className="text-muted-foreground flex items-start gap-2 text-xs">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  YouTube didn&apos;t answer, so this is a stored list of the
                  categories it accepts for US channels. It may not match what
                  your channel&apos;s region allows.
                </p>
              )}

              {/* The audience declaration, and the reason it is a bordered
                * block rather than a fourth field in the stack: it is not a
                * preference like the two above it. It is a legal statement
                * under COPPA, the question has a specific test behind it, and
                * turning it on changes what YouTube permits on every video
                * this channel has. None of that fits on one line of helper
                * text, and an operator who cannot answer it correctly is the
                * failure mode this whole setting exists to prevent.
                *
                * Word for word what the dialog this replaced showed. The
                * strings come from `youtube-audience.ts`, which exists so the
                * screen that asks the question and the dialog that states the
                * answer cannot drift; moving the question to a new screen is
                * not a reason to restate it in new words. */}
              <Controller
                control={control}
                name="madeForKids"
                render={({ field }) => (
                  <div className="space-y-2 rounded-lg border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <label
                        htmlFor={audienceId}
                        className="flex flex-col items-start gap-1 text-sm"
                      >
                        <span className="font-medium">
                          {MADE_FOR_KIDS_QUESTION}
                        </span>
                        <span className="text-muted-foreground text-xs">
                          {MADE_FOR_KIDS_TEST}
                        </span>
                      </label>
                      <Switch
                        id={audienceId}
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        className="mt-0.5"
                      />
                    </div>

                    {/* Stated whichever way the switch is set, because both
                      * answers have consequences and only one of them is
                      * visible as a change. An operator turning it *on* should
                      * see what it costs before saving; an operator leaving it
                      * off should see that "off" is itself a declaration. */}
                    {field.value ? (
                      <div className="text-muted-foreground space-y-1 text-xs">
                        <p className="text-foreground font-medium">
                          Every upload from this channel — videos and shorts —
                          will be declared made for kids. On each one:
                        </p>
                        <ul className="list-disc space-y-0.5 pl-4">
                          {MADE_FOR_KIDS_CONSEQUENCES.map((consequence) => (
                            <li key={consequence}>{consequence}</li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <p className="text-muted-foreground text-xs">
                        Every upload from this channel — videos and shorts —
                        will be declared <strong>not</strong> made for kids,
                        keeping comments, notifications and personalised ads.
                        Declaring this wrongly is not a YouTube technicality:
                        the US FTC has taken action against creators under COPPA
                        over child-directed content declared otherwise.
                      </p>
                    )}

                    <a
                      href={MADE_FOR_KIDS_GUIDANCE_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted-foreground inline-flex items-center gap-1 text-xs underline underline-offset-3"
                    >
                      YouTube&apos;s guidance on this question
                      <ExternalLink className="size-3" />
                    </a>
                  </div>
                )}
              />

              {/* Last, and after the audience block on purpose: it is the one
                * field here YouTube never sees, and it is the one an operator
                * most often wants to change right after answering the question
                * above. A channel directed to children almost always wants
                * cartoons; keeping the two questions together is what stops a
                * kids channel being declared for kids and then illustrated
                * with live-action stock. */}
              <Controller
                control={control}
                name="footageStyle"
                render={({ field }) => (
                  <FormField
                    name="footageStyle"
                    label="Footage"
                    description={
                      FOOTAGE_STYLES.find(
                        (option) => option.value === field.value,
                      )?.description
                    }
                    error={errors.footageStyle?.message}
                  >
                    {(controlProps) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger {...controlProps} className="w-full sm:w-64">
                          <SelectValue placeholder="Pick a footage style" />
                        </SelectTrigger>
                        <SelectContent>
                          {FOOTAGE_STYLES.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </FormField>
                )}
              />

              {/* Only for the style that reads it. This is the longest field on
                * the screen and it is meaningless to a live-action or cartoon
                * channel — showing it to every channel would put a paragraph
                * box under a setting most of them will never use, and hiding
                * it is safe here because the value is preserved on save either
                * way (the field stays registered, holding whatever was
                * loaded). */}
              {footageStyle === "ILLUSTRATED" && (
                <Controller
                  control={control}
                  name="artStyle"
                  render={({ field }) => (
                    <FormField
                      name="artStyle"
                      label="Art style"
                      description={
                        findArtStyle(field.value)?.description ??
                        "Every illustration on this channel is drawn in one named look, including the character sheet. There is no default — a default would give every channel the same look, which is the opposite of the point — so this has to be chosen before any illustrated video can collect footage."
                      }
                      error={errors.artStyle?.message}
                    >
                      {(controlProps) => (
                        <Select
                          // `""` stands for "nobody has chosen" — a Select
                          // value has to be a string, and the schema coerces
                          // it back to null.
                          value={field.value ?? ""}
                          onValueChange={field.onChange}
                        >
                          <SelectTrigger {...controlProps} className="w-full sm:w-64">
                            <SelectValue placeholder="Pick an art style" />
                          </SelectTrigger>
                          <SelectContent>
                            {ART_STYLES.map((option) => (
                              <SelectItem key={option.id} value={option.id}>
                                {option.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </FormField>
                  )}
                />
              )}

              {footageStyle === "ILLUSTRATED" && (
                <FormField
                  name="characterBrief"
                  label="The recurring character"
                  description="Who appears in every scene, and exactly what they look like. This is the one thing the script cannot tell the illustrator: a story says “the little bear set off down the path”, not that the bear is brown with a cream muzzle and a red knitted scarf. Be specific and be long — colour, build, ears, eyes, clothing, expression. Vague descriptions produce a different character in every picture."
                  error={errors.characterBrief?.message}
                >
                  {(controlProps) => (
                    <Textarea
                      rows={6}
                      placeholder={
                        "Pip, a small round brown bear cub with a cream-coloured muzzle, big dark friendly eyes, " +
                        "small rounded ears and a red knitted scarf. Always cheerful, never frightening."
                      }
                      className="w-full"
                      {...register("characterBrief")}
                      {...controlProps}
                    />
                  )}
                </FormField>
              )}
            </FieldGroup>
          </CardContent>
        </Card>
      </Reveal>

      {/* Stacked and full-width on a phone, inline on a desktop — the primary
        * action of a long form is the last thing that should be a 110px target
        * at the bottom of a 375px screen. In DOM order rather than reversed,
        * so the visual order and the tab order agree. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
        <Button type="submit" disabled={isSubmitting || !isDirty}>
          {isSubmitting && <Loader2 className="animate-spin" />}
          Save branding
        </Button>
        {isDirty && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => reset(toDefaultValues(saved))}
          >
            Discard changes
          </Button>
        )}
      </div>
    </form>
  );
}

/** Narrowed to what each card actually touches, so a card cannot reach a field
 *  that belongs to another one. */
type FormApi = ReturnType<typeof useForm<BrandingFormValues, unknown, BrandingFormOutput>>;

function LookCard({
  control,
  register,
  errors,
}: {
  control: FormApi["control"];
  register: FormApi["register"];
  errors: FormApi["formState"]["errors"];
}) {
  // Watched rather than read from `getValues`, because the preview has to
  // repaint as the colour picker is dragged — `getValues` does not re-render.
  const [primaryColour, headlineFont] = useWatch({
    control,
    name: ["primaryColour", "headlineFont"],
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Look</CardTitle>
        <CardDescription>
          The colour and the face of the headline burned into every thumbnail
          this channel generates. Burned in by FFmpeg, not drawn by the browser
          — which is why the font is a list and not a text box.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <FieldGroup>
          <ColourField
            control={control}
            register={register}
            name="primaryColour"
            label="Primary colour"
            description="The headline text on thumbnails. Six-digit hex — anything else is refused here, because FFmpeg would silently draw it white."
            error={errors.primaryColour?.message}
          />

          <ColourField
            control={control}
            register={register}
            name="secondaryColour"
            label="Secondary colour"
            description="Stored against the channel. Nothing in the render path reads it yet — it is here so the pair is set together rather than half-set later."
            error={errors.secondaryColour?.message}
          />

          <Controller
            control={control}
            name="headlineFont"
            render={({ field }) => (
              <FormField
                name="headlineFont"
                label="Headline font"
                description={
                  BRAND_FONTS.find((font) => font.value === field.value)
                    ?.description
                }
                note="Only fonts installed in the render worker's image are listed. FFmpeg falls back to a default face without warning on a font it cannot find, so a name that is not on this list produces a video that looks unstyled and says nothing about why."
                error={errors.headlineFont?.message}
              >
                {(controlProps) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger {...controlProps} className="w-full sm:w-64">
                      <SelectValue placeholder="Pick a font" />
                    </SelectTrigger>
                    <SelectContent>
                      {BRAND_FONTS.map((font) => (
                        <SelectItem key={font.value} value={font.value}>
                          {font.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </FormField>
            )}
          />

          <HeadlinePreview colour={primaryColour} font={headlineFont} />
        </FieldGroup>
      </CardContent>
    </Card>
  );
}

/**
 * A hex colour with two ways in, both of them keyboard-reachable.
 *
 * The swatch is a native `<input type="color">`: focusable, opened with Space
 * or Enter, and the only control that lets someone pick a colour by looking at
 * it. It is not sufficient on its own — its picker is an operating-system
 * dialog with no relationship to this page's accessibility tree, and there is
 * no way to *type* a known brand hex into it on every platform. So the text
 * box beside it is the labelled control, holds the same registered field, and
 * is what a screen reader or a keyboard-only operator uses; the swatch writes
 * into the same field through `Controller` and carries an `aria-label` of its
 * own rather than a second `<label>` competing for the same name.
 */
function ColourField({
  control,
  register,
  name,
  label,
  description,
  error,
}: {
  control: FormApi["control"];
  register: FormApi["register"];
  name: "primaryColour" | "secondaryColour";
  label: string;
  description: string;
  error?: string;
}) {
  return (
    <FormField name={name} label={label} description={description} error={error}>
      {(controlProps) => (
        <div className="flex items-center gap-2">
          <Controller
            control={control}
            name={name}
            render={({ field }) => (
              <input
                type="color"
                // `value` has to be a valid hex for the swatch to render at
                // all; while the text box holds a half-typed value the swatch
                // keeps the last good one rather than snapping to black.
                value={/^#[0-9a-fA-F]{6}$/.test(field.value) ? field.value : "#000000"}
                onChange={(event) => field.onChange(event.target.value)}
                onBlur={field.onBlur}
                aria-label={`${label} swatch`}
                className="border-input size-9 shrink-0 cursor-pointer rounded-md border bg-transparent p-1"
              />
            )}
          />
          <Input
            placeholder="#FFFFFF"
            autoComplete="off"
            spellCheck={false}
            className="w-32 font-mono uppercase"
            {...register(name)}
            {...controlProps}
          />
        </div>
      )}
    </FormField>
  );
}

/**
 * Tone and niche — the two phrases that reach into every prompt.
 *
 * Called "Writing" rather than "Voice", which is what it was titled until this
 * channel had an actual narration voice to choose. Two cards named for the
 * same word, one meaning "how the prompts are worded" and the other "who reads
 * the script aloud", is the kind of ambiguity an operator only resolves by
 * changing the wrong one and listening to the result.
 */
function WritingCard({
  register,
  errors,
}: {
  register: FormApi["register"];
  errors: FormApi["formState"]["errors"];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Writing</CardTitle>
        <CardDescription>
          Two short phrases that reach further than anything else on this page.
          They are interpolated into four separate prompts, so a careless answer
          does not produce one bad video — it produces a channel of them.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Named in full rather than summarised as "used in generation".
          * Nothing about these fields advertises how far they reach, and an
          * operator who thinks "tone" is a label on a settings page fills it
          * in the way you fill in a label. */}
        <ul className="text-muted-foreground list-disc space-y-1 pl-4 text-xs">
          <li>
            The <strong>thumbnail</strong> image prompt — what the generated
            background is a picture of.
          </li>
          <li>
            The <strong>logo</strong> prompt above, every time you generate
            options.
          </li>
          <li>
            The <strong>shorts moment-picker</strong>, which reads the niche and
            tone before deciding which parts of a finished video are worth
            cutting.
          </li>
          <li>
            The generated <strong>title, description and tags</strong> — the
            metadata YouTube ranks the video on.
          </li>
        </ul>
        <p className="text-muted-foreground text-xs">
          Not the script. A script prompt declares its own tone variable with
          its own default, edited under Prompts, and it is not filled in from
          here.
        </p>

        <FieldGroup>
          <FormField
            name="tone"
            label="Tone"
            description={`How it should sound. A few words, not a sentence. Leave it empty to fall back to "${FALLBACK_PLACEHOLDERS.tone}".`}
            error={errors.tone?.message}
          >
            {(controlProps) => (
              <Input
                placeholder={FALLBACK_PLACEHOLDERS.tone}
                autoComplete="off"
                className="w-full sm:max-w-sm"
                {...register("tone")}
                {...controlProps}
              />
            )}
          </FormField>

          <FormField
            name="niche"
            label="Niche"
            description={`What the channel is about, as you would say it to someone who asked. Leave it empty to fall back to "${FALLBACK_PLACEHOLDERS.niche}".`}
            error={errors.niche?.message}
          >
            {(controlProps) => (
              <Input
                placeholder={FALLBACK_PLACEHOLDERS.niche}
                autoComplete="off"
                className="w-full sm:max-w-sm"
                {...register("niche")}
                {...controlProps}
              />
            )}
          </FormField>
        </FieldGroup>
      </CardContent>
    </Card>
  );
}

/**
 * Which voice reads this channel's scripts, from now on.
 *
 * The list, the previews, the three ways asking ElevenLabs can go and the
 * "your saved voice is not in this list" row all live in `VoicePicker`, which
 * the re-narrate dialog on the video page renders too — see its doc comment
 * for why one control serves both questions. Everything left here is what is
 * specific to *this* screen: the sentinel row for "no voice chosen", which the
 * dialog has no equivalent of, and keeping `voiceName` in step with `voiceId`
 * inside the form.
 *
 * The "deployment default" row is present in every state, because it is always
 * a valid answer and it is the one every channel is already on.
 */
function NarrationCard({
  control,
  setValue,
  errors,
}: {
  control: FormApi["control"];
  setValue: FormApi["setValue"];
  errors: FormApi["formState"]["errors"];
}) {
  // Watched rather than read once: it is written by `setValue` from this very
  // card, and it is what names a saved voice that the fetched list does not
  // contain.
  const savedName = useWatch({ control, name: "voiceName" });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Narration voice</CardTitle>
        <CardDescription>
          Who reads this channel&apos;s scripts. Listed from your own ElevenLabs
          account, because that is the only place that knows which voices you
          actually have — nothing here is a stored list of voice ids.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Changing this changes what the channel narrates with *next*, which
          * is not the same thing as changing a video you have already made —
          * and an operator who came here after listening to one is exactly the
          * person about to assume otherwise. */}
        <p className="text-muted-foreground text-xs">
          This applies to narration from here on. Videos already narrated keep
          the voice they were made in; a finished one can be re-narrated from
          its own page, which re-runs the pipeline from narration onward.
        </p>

        <Controller
          control={control}
          name="voiceId"
          render={({ field }) => (
            <VoicePicker
              value={field.value ?? DEFAULT_VOICE}
              onChange={(next, name) => {
                if (next === DEFAULT_VOICE) {
                  field.onChange(null);
                  // Cleared together. `updateBranding` enforces this again at
                  // the write, but leaving a stale name in the form would show
                  // the old voice's name against the default until the next
                  // reload.
                  setValue("voiceName", null, { shouldDirty: true });
                  return;
                }

                field.onChange(next);
                setValue("voiceName", name, { shouldDirty: true });
              }}
              defaultChoice={{
                value: DEFAULT_VOICE,
                name: "The deployment's default voice",
                detail: (
                  <span className="text-muted-foreground block text-xs">
                    Whatever ELEVENLABS_VOICE_ID is set to on this installation.
                    What every channel narrated with before this setting
                    existed, and what a channel goes back to when you pick it
                    again.
                  </span>
                ),
              }}
              unlistedName={savedName ?? "Saved voice"}
              unlistedDetail={(voiceId) => (
                <span className="text-muted-foreground block text-xs">
                  <span className="font-mono">{voiceId}</span> — saved on this
                  channel but not in the list above. It is still what narration
                  uses.
                </span>
              )}
              ariaLabel="Narration voice"
              invalid={Boolean(errors.voiceId)}
            />
          )}
        />

        {errors.voiceId?.message && (
          <FieldError>{errors.voiceId.message}</FieldError>
        )}
      </CardContent>
    </Card>
  );
}

function MusicCard({
  register,
  errors,
}: {
  register: FormApi["register"];
  errors: FormApi["formState"]["errors"];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Music</CardTitle>
        <CardDescription>
          What Jamendo is searched for when a render needs a bed. Fetched, never
          generated — a video that finds nothing simply renders without music.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* The reasoning behind the field, because without it the obvious
          * thing to type is what the video is about — which is exactly what
          * was tried and exactly what failed. */}
        <p className="text-muted-foreground text-xs">
          Describe the <strong>music</strong>, not the channel. Searching by
          video title was the first thing this pipeline did and it found nothing
          usable: &ldquo;Ada Lovelace wrote the first program&rdquo; is not a
          musical description. It is one query per channel rather than per video
          for the same reason a channel has one logo — a channel whose music
          changes every episode does not sound like a channel.
        </p>

        <FieldGroup>
          <FormField
            name="musicQuery"
            label="Music search"
            description={`Instruments, mood, tempo — the words a stock library files music under. Leave it empty to fall back to "${FALLBACK_PLACEHOLDERS.musicQuery}".`}
            error={errors.musicQuery?.message}
          >
            {(controlProps) => (
              <Input
                placeholder={FALLBACK_PLACEHOLDERS.musicQuery}
                autoComplete="off"
                className="w-full sm:max-w-sm"
                {...register("musicQuery")}
                {...controlProps}
              />
            )}
          </FormField>
        </FieldGroup>
      </CardContent>
    </Card>
  );
}
