/**
 * Everything the new-series wizard decides that is not rendering: the step
 * list, what each step needs before Continue, how a niche preset fills the
 * draft, and how the draft becomes the two payloads the server accepts.
 *
 * Pure and client-safe, so it can be tested without a browser or a database —
 * the screens import it and do nothing cleverer than call it.
 *
 * ── Two payloads, one draft ────────────────────────────────────────────────
 * A series inherits its voice, music, look and captions from its channel (see
 * `series.schema.ts`), so the wizard's answers to those four questions are
 * *channel* settings. They leave through `updateBrandingAction` — the same
 * write the branding screen uses, with the channel's other fields sent back
 * unchanged — and everything else leaves through `createSeriesAction` exactly
 * as the old one-page form sent it. Neither contract changes shape for the
 * wizard's sake.
 */

import type { FootageStyle, PublishVisibility, VideoFormat } from "@/generated/prisma/enums";
import type { ArtStyleId } from "@/lib/art-styles";
import { BRAND_FONTS } from "@/lib/brand-fonts";
import { DOODLE_BEAT_MAX_SECONDS, DOODLE_BEAT_MIN_SECONDS } from "@/lib/doodle-cadence";
import { stylePicksArtStyle } from "@/lib/footage-styles";
import { findStylePreset } from "@/lib/style-presets";
import { styleBaseFor, type CaptionMode } from "@/lib/video-style";
import { updateBrandingSchema } from "@/schemas/channel.schema";
import { MAX_TOPICS } from "@/schemas/schedule.schema";
import { createSeriesSchema } from "@/schemas/series.schema";
import type { AutomationField, AutomationScriptStyle } from "@/services/automation.service";
import type { ChannelBranding } from "@/services/brand.service";
import type { SeriesSetup } from "@/services/series.service";

import { resolvePresetStyle, type NichePreset } from "./niche-presets";

export type WizardStepId =
  | "niche"
  | "topics"
  | "channel"
  | "voice"
  | "music"
  | "look"
  | "captions"
  | "schedule"
  | "review";

export interface WizardStep {
  id: WizardStepId;
  /** Short, for the progress bar's screen-reader text and the summary. */
  label: string;
  optional?: boolean;
}

/**
 * In the order an operator describes a show: what it is about, what it says,
 * where it goes, what it sounds and looks like, when, and whether it publishes
 * itself. The channel comes before the four channel-level steps because those
 * steps edit *that* channel, and show its current answers as the starting
 * point.
 */
export const WIZARD_STEPS: readonly WizardStep[] = [
  { id: "niche", label: "Niche" },
  { id: "topics", label: "Name & topics" },
  { id: "channel", label: "Channel & format" },
  { id: "voice", label: "Voice" },
  { id: "music", label: "Music", optional: true },
  { id: "look", label: "Look" },
  { id: "captions", label: "Captions" },
  { id: "schedule", label: "Schedule" },
  { id: "review", label: "Publish & review" },
];

/** The channel settings the wizard edits, as the draft holds them. */
export interface BrandDraft {
  voiceId: string | null;
  voiceName: string | null;
  /** Null is "use the fallback", exactly as on the branding screen. */
  musicQuery: string | null;
  footageStyle: FootageStyle;
  artStyle: ArtStyleId | null;
  beatSeconds: number | null;
  /**
   * Null means "not chosen in the wizard — whatever the channel resolves to".
   * Kept apart from the resolved value so that changing the footage style on
   * the look step moves the caption default with it, until the operator picks
   * a caption mode themselves.
   */
  captionMode: CaptionMode | null;
}

export type Frequency = "DAILY" | "WEEKLY" | "MONTHLY";

export interface SeriesDraft {
  /** Which card was picked on the first step. `custom` is "I'll choose a
   *  script style myself"; null is nothing picked yet. */
  nichePresetId: string | null;
  name: string;
  promptTemplateId: string;
  variables: Record<string, string>;
  topicText: string;
  channelId: string;
  projectId: string;
  format: VideoFormat;
  /** The channel `brand` was initialised from. Differing from `channelId`
   *  means the channel changed and `brand` has to be re-read. */
  brandChannelId: string | null;
  /** The channel's `updatedAt` when `brand` was read, so a draft restored
   *  after the branding screen saved something newer is re-read rather than
   *  written back over that save. */
  brandVersion: string | null;
  brand: BrandDraft | null;
  frequency: Frequency;
  dayOfWeek: number;
  dayOfMonth: number;
  /** `HH:MM`, as `<input type="time">` holds it. */
  time: string;
  /** Empty until the browser's zone is detected after mount. */
  timeZone: string;
  autoPublish: boolean;
  publishVisibility: PublishVisibility;
  autoShorts: boolean;
}

/** What validation needs to know besides the draft. */
export interface WizardContext {
  setup: Pick<SeriesSetup, "channels" | "projects" | "scriptStyles">;
  brandings: Record<string, ChannelBranding>;
}

// ---------------------------------------------------------------------------
// Building the draft
// ---------------------------------------------------------------------------

/**
 * The caption mode a channel would render with if the wizard wrote nothing:
 * its stored choice, else what its footage style and preset supply — the same
 * layering `brandService.resolve` applies.
 */
export function inheritedCaptionMode(
  branding: Pick<ChannelBranding, "captionMode" | "stylePreset">,
  footageStyle: FootageStyle,
): CaptionMode {
  return (
    branding.captionMode ??
    styleBaseFor(footageStyle, findStylePreset(branding.stylePreset)?.video).captionMode
  );
}

export function brandDraftFrom(branding: ChannelBranding): BrandDraft {
  return {
    voiceId: branding.voiceId,
    voiceName: branding.voiceName,
    musicQuery: branding.musicQuery,
    footageStyle: branding.footageStyle,
    artStyle: branding.artStyle,
    beatSeconds: branding.beatSeconds,
    captionMode: null,
  };
}

/** The caption mode the captions step shows as selected. */
export function displayedCaptionMode(
  draft: SeriesDraft,
  context: WizardContext,
): CaptionMode | null {
  const branding = context.brandings[draft.channelId];

  if (!draft.brand || !branding) {
    return null;
  }

  return draft.brand.captionMode ?? inheritedCaptionMode(branding, draft.brand.footageStyle);
}

export function initialDraft(context: WizardContext): SeriesDraft {
  const { setup } = context;
  // Default to a channel that actually has a project pointing at it — the
  // same choice the one-page form made, for the same reason: anything else
  // opens the channel step on its own "no project publishes here" refusal.
  const channelId =
    setup.channels.find((channel) =>
      setup.projects.some((project) => project.channelId === channel.id),
    )?.id ??
    setup.channels[0]?.id ??
    "";

  const draft: SeriesDraft = {
    nichePresetId: null,
    name: "",
    promptTemplateId:
      setup.scriptStyles.find((style) => style.isDefault)?.id ??
      setup.scriptStyles[0]?.id ??
      "",
    variables: {},
    topicText: "",
    channelId: "",
    projectId: "",
    format: "LANDSCAPE",
    brandChannelId: null,
    brandVersion: null,
    brand: null,
    frequency: "WEEKLY",
    dayOfWeek: 1,
    dayOfMonth: 1,
    time: "09:00",
    timeZone: "",
    // Off for a new show, and that default is the point — see
    // `Series.autoPublish` in schema.prisma.
    autoPublish: false,
    publishVisibility: "PRIVATE",
    autoShorts: false,
  };

  return channelId ? chooseChannel(draft, channelId, context) : draft;
}

/**
 * Picks a channel, and with it a project and the channel's current brand.
 *
 * The project is kept when it already publishes to the new channel and
 * otherwise becomes the first that does — `setup.projects` is ordered most
 * recently updated first, which is the nearest thing to "this channel's usual
 * project" the data has. Only projects that publish to the channel are ever
 * offered, because the renderer resolves the brand through
 * `video -> project -> channel` and the server refuses a mismatched pair.
 *
 * The brand draft is re-read on any change of channel. Answers given on the
 * voice or look steps for the *previous* channel would otherwise be written
 * onto this one, which is a different channel's identity.
 */
export function chooseChannel(
  draft: SeriesDraft,
  channelId: string,
  context: WizardContext,
): SeriesDraft {
  const projects = projectsFor(channelId, context);
  const projectId = projects.some((project) => project.id === draft.projectId)
    ? draft.projectId
    : (projects[0]?.id ?? "");

  const branding = context.brandings[channelId];
  const keepBrand = draft.brandChannelId === channelId && draft.brand !== null;

  if (keepBrand) {
    return { ...draft, channelId, projectId };
  }

  return {
    ...draft,
    channelId,
    projectId,
    brandChannelId: branding ? channelId : null,
    brandVersion: branding ? brandingVersion(branding) : null,
    brand: branding ? brandDraftFrom(branding) : null,
  };
}

function brandingVersion(branding: ChannelBranding): string {
  // A `Date` from the server component, or an ISO string once it has been
  // through session storage — compared as the same string either way.
  return branding.updatedAt ? new Date(branding.updatedAt).toISOString() : "never";
}

export function projectsFor(channelId: string, context: WizardContext) {
  return context.setup.projects.filter((project) => project.channelId === channelId);
}

/** The variables a script style asks about: its own fields plus `duration`
 *  when it declares one — the same list the one-page form showed. */
export function declaredFields(style: AutomationScriptStyle | null): AutomationField[] {
  if (!style) {
    return [];
  }

  return style.duration ? [...style.fields, style.duration] : style.fields;
}

/**
 * Switches the script style and keeps only the answers the new one asks for.
 * An answer to a variable the style does not declare is invisible on screen
 * and discarded by the service, so carrying it would only make the review
 * step disagree with what gets stored.
 */
export function chooseScriptStyle(
  draft: SeriesDraft,
  promptTemplateId: string,
  scriptStyles: readonly AutomationScriptStyle[],
): SeriesDraft {
  const style = scriptStyles.find((entry) => entry.id === promptTemplateId) ?? null;
  const keys = new Set(declaredFields(style).map((field) => field.key));

  return {
    ...draft,
    promptTemplateId,
    variables: Object.fromEntries(
      Object.entries(draft.variables).filter(([key]) => keys.has(key)),
    ),
  };
}

/**
 * Fills the draft from a niche preset without trampling what the operator
 * has already written.
 *
 * The name and the topic list are replaced only while they are empty or still
 * exactly what an earlier preset put there. Somebody who picked "Mythology",
 * rewrote the topics, went back and clicked "Mysteries" has lost nothing —
 * their list is theirs now. Variable answers follow the same rule per key.
 */
export function applyNichePreset(
  draft: SeriesDraft,
  preset: NichePreset,
  previous: NichePreset | null,
  scriptStyles: readonly AutomationScriptStyle[],
): SeriesDraft {
  const style = resolvePresetStyle(preset, scriptStyles);
  const withStyle = style ? chooseScriptStyle(draft, style.id, scriptStyles) : draft;
  const declared = new Set(declaredFields(style).map((field) => field.key));

  const untouched = (current: string, previousValue: string | undefined) =>
    current.trim() === "" || (previousValue !== undefined && current === previousValue);

  const variables = { ...withStyle.variables };

  for (const key of ["audience", "tone"] as const) {
    const next = preset.variables[key];

    if (!next || !declared.has(key)) {
      continue;
    }

    if (untouched(variables[key] ?? "", previous?.variables[key])) {
      variables[key] = next;
    }
  }

  return {
    ...withStyle,
    nichePresetId: preset.id,
    name: untouched(draft.name, previous?.seriesName) ? preset.seriesName : draft.name,
    topicText: untouched(draft.topicText, previous ? previous.topics.join("\n") : undefined)
      ? preset.topics.join("\n")
      : draft.topicText,
    variables,
  };
}

// ---------------------------------------------------------------------------
// Reading the draft
// ---------------------------------------------------------------------------

export function parseTopics(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function parseTime(time: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);

  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

/** The payload `createSeriesAction` receives — the same shape the one-page
 *  form sent, plus `autoShorts`, which the schema always accepted. */
export function toCreateSeriesInput(draft: SeriesDraft) {
  const time = parseTime(draft.time) ?? { hour: 0, minute: 0 };

  return {
    name: draft.name.trim(),
    channelId: draft.channelId,
    projectId: draft.projectId,
    promptTemplateId: draft.promptTemplateId,
    format: draft.format,
    autoPublish: draft.autoPublish,
    publishVisibility: draft.publishVisibility,
    autoShorts: draft.autoShorts,
    frequency: draft.frequency,
    dayOfWeek: draft.frequency === "WEEKLY" ? draft.dayOfWeek : null,
    dayOfMonth: draft.frequency === "MONTHLY" ? draft.dayOfMonth : null,
    hour: time.hour,
    minute: time.minute,
    timeZone: draft.timeZone,
    // Blank answers are dropped rather than sent as "", so a style's own
    // default applies — the rule the one-page form's placeholders described.
    variables: Object.fromEntries(
      Object.entries(draft.variables).filter(([, value]) => value.trim().length > 0),
    ),
    topics: parseTopics(draft.topicText),
  };
}

/** Which channel settings the draft changes, by the label the summary uses.
 *  Empty means the brand write is skipped entirely. */
export function brandChanges(draft: SeriesDraft, branding: ChannelBranding): string[] {
  const brand = draft.brand;

  if (!brand) {
    return [];
  }

  const changed: string[] = [];

  if (brand.voiceId !== branding.voiceId) changed.push("voice");
  if ((brand.musicQuery ?? null) !== (branding.musicQuery ?? null)) changed.push("music");
  if (
    brand.footageStyle !== branding.footageStyle ||
    brand.artStyle !== branding.artStyle ||
    brand.beatSeconds !== branding.beatSeconds
  ) {
    changed.push("look");
  }
  if (captionModeToWrite(brand, branding)) changed.push("captions");

  return changed;
}

/**
 * The caption mode to send, or undefined to leave the stored style alone.
 *
 * Sent only when the operator picked a mode that differs from what the channel
 * would inherit anyway. Writing the inherited one would pin it (see
 * `captionMode` in channel.schema.ts), so a later preset or footage change
 * would silently stop reaching the captions.
 */
function captionModeToWrite(
  brand: BrandDraft,
  branding: ChannelBranding,
): CaptionMode | undefined {
  if (!brand.captionMode) {
    return undefined;
  }

  return brand.captionMode === inheritedCaptionMode(branding, brand.footageStyle)
    ? undefined
    : brand.captionMode;
}

/**
 * The full branding payload: the channel's current values with the wizard's
 * answers over them. `updateBrandingSchema` requires every field, because the
 * branding screen has one Save — so the fields this flow does not touch are
 * sent back exactly as they were read, with the one coercion the branding
 * screen itself applies (a headline font no longer on the list).
 */
export function toBrandingInput(draft: SeriesDraft, branding: ChannelBranding) {
  const brand = draft.brand ?? brandDraftFrom(branding);

  return {
    channelId: draft.channelId,
    primaryColour: branding.primaryColour,
    secondaryColour: branding.secondaryColour,
    headlineFont:
      BRAND_FONTS.find((font) => font.value === branding.headlineFont)?.value ??
      BRAND_FONTS[0].value,
    tone: branding.tone,
    niche: branding.niche,
    musicQuery: brand.musicQuery,
    voiceId: brand.voiceId,
    voiceName: brand.voiceId ? brand.voiceName : null,
    language: branding.language,
    categoryId: branding.categoryId,
    madeForKids: branding.madeForKids,
    footageStyle: brand.footageStyle,
    characterBrief: branding.characterBrief,
    artStyle: brand.artStyle,
    stylePreset: branding.stylePreset,
    beatSeconds: brand.beatSeconds,
    captionMode: captionModeToWrite(brand, branding),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Why Continue is refused on this step, in words, or null when it is not.
 *
 * Each step checks only its own answers; the review step re-runs both server
 * schemas over the finished payloads, so nothing the server would refuse can
 * reach it looking valid.
 */
export function validateStep(
  step: WizardStepId,
  draft: SeriesDraft,
  context: WizardContext,
): string | null {
  const { setup } = context;

  switch (step) {
    case "niche":
      if (!draft.nichePresetId) {
        return "Pick a niche, or choose a script style under Custom.";
      }
      return setup.scriptStyles.some((style) => style.id === draft.promptTemplateId)
        ? null
        : "Pick the script style that writes each episode.";

    case "topics": {
      const name = draft.name.trim();

      if (name.length === 0) return "Give the series a name.";
      if (name.length > 80) return "Keep the name to 80 characters.";

      const style =
        setup.scriptStyles.find((entry) => entry.id === draft.promptTemplateId) ?? null;
      const missing = declaredFields(style).filter(
        (field) =>
          field.required && !field.defaultValue && !(draft.variables[field.key] ?? "").trim(),
      );

      if (missing.length > 0) {
        return `The script style needs: ${missing.map((field) => field.label).join(", ")}.`;
      }

      const topics = parseTopics(draft.topicText);

      if (topics.length === 0) return "Write at least one topic — nothing here invents a subject.";
      if (topics.length > MAX_TOPICS) return `A series can start with at most ${MAX_TOPICS} topics.`;
      if (topics.some((topic) => topic.length < 3)) return "Every topic needs a few more words.";
      if (topics.some((topic) => topic.length > 300)) return "Keep each topic to 300 characters.";

      return null;
    }

    case "channel":
      if (!setup.channels.some((channel) => channel.id === draft.channelId)) {
        return "Pick a channel.";
      }
      return projectsFor(draft.channelId, context).some(
        (project) => project.id === draft.projectId,
      )
        ? null
        : "Pick a project that publishes to this channel.";

    case "voice":
    case "captions":
      return draft.brand ? null : "Pick a channel first.";

    case "music":
      if (!draft.brand) return "Pick a channel first.";
      return (draft.brand.musicQuery ?? "").length > 160
        ? "Keep the music search to a few words."
        : null;

    case "look": {
      const brand = draft.brand;

      if (!brand) return "Pick a channel first.";

      // Refused here rather than at render: footage.service.ts refuses a
      // drawn style with no art style, and the doodle writer refuses a
      // channel with no rhythm — both after the series has started spending.
      if (stylePicksArtStyle(brand.footageStyle) && !brand.artStyle) {
        return "Pick the art style the pictures are drawn in.";
      }
      if (
        brand.footageStyle === "DOODLE" &&
        (brand.beatSeconds === null ||
          brand.beatSeconds < DOODLE_BEAT_MIN_SECONDS ||
          brand.beatSeconds > DOODLE_BEAT_MAX_SECONDS)
      ) {
        return `Pick how long each drawing holds the screen (${DOODLE_BEAT_MIN_SECONDS}–${DOODLE_BEAT_MAX_SECONDS} seconds).`;
      }
      return null;
    }

    case "schedule":
      if (!draft.timeZone) return "Pick a timezone.";
      if (!parseTime(draft.time)) return "Pick a time of day.";
      return null;

    case "review": {
      const series = createSeriesSchema.safeParse(toCreateSeriesInput(draft));

      if (!series.success) {
        return series.error.issues[0]?.message ?? "Something in the series is not valid.";
      }

      const branding = context.brandings[draft.channelId];

      if (branding && brandChanges(draft, branding).length > 0) {
        const brand = updateBrandingSchema.safeParse(toBrandingInput(draft, branding));

        if (!brand.success) {
          // A stored value the branding screen would now refuse — named, so
          // the operator knows to fix it there rather than here.
          const issue = brand.error.issues[0];
          return `This channel's saved ${String(issue?.path[0] ?? "settings")} is not valid any more: ${issue?.message ?? "fix it on the channel's branding screen"}.`;
        }
      }

      return null;
    }
  }
}

/** The index of the first step that is not ready, or the last step when all
 *  are. A URL naming a later step than this is clamped to it, so a refresh or
 *  a hand-edited `?step=` can never land past an unanswered question. */
export function firstIncompleteStep(draft: SeriesDraft, context: WizardContext): number {
  const index = WIZARD_STEPS.findIndex(
    (step) => step.id !== "review" && validateStep(step.id, draft, context) !== null,
  );

  return index === -1 ? WIZARD_STEPS.length - 1 : index;
}

/**
 * A draft restored from session storage, checked against what exists now.
 *
 * The draft outlives the page (a refresh, or a detour to connect a channel),
 * and in that time a channel can be disconnected or a script style deleted.
 * Anything that no longer resolves falls back to the fresh draft's answer
 * rather than being submitted as a dangling id.
 */
export function reconcileDraft(
  stored: Partial<SeriesDraft>,
  context: WizardContext,
): SeriesDraft {
  const fresh = initialDraft(context);
  let draft: SeriesDraft = { ...fresh, ...stored, variables: { ...(stored.variables ?? {}) } };

  if (!context.setup.scriptStyles.some((style) => style.id === draft.promptTemplateId)) {
    draft = { ...draft, promptTemplateId: fresh.promptTemplateId, nichePresetId: null };
  }

  if (!context.setup.channels.some((channel) => channel.id === draft.channelId)) {
    draft = { ...draft, channelId: "", brandChannelId: null, brandVersion: null, brand: null };
    return fresh.channelId ? chooseChannel(draft, fresh.channelId, context) : draft;
  }

  const branding = context.brandings[draft.channelId];

  if (!branding || draft.brandVersion !== brandingVersion(branding)) {
    draft = { ...draft, brandChannelId: null, brandVersion: null, brand: null };
  }

  // Re-run the channel choice so the project and brand are re-checked too.
  return chooseChannel(draft, draft.channelId, context);
}
