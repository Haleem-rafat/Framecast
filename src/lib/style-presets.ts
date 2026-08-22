import type { FootageStyle } from "@/generated/prisma/enums";
import type { ArtStyleId } from "@/lib/art-styles";
import type { VideoStyle } from "@/lib/video-style";

/**
 * The named looks a channel can be set to in one choice.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Every element of a finished look already shipped, and none of it could be
 * picked. Reproducing one of this app's own published Shorts on a new channel
 * meant setting five things across three places: `footageStyle`, `artStyle` and
 * `beatSeconds` are columns the branding screen edits; `captionMode`, `motion`
 * and `transitions` live inside the `videoStyle` JSON that `brand.service.ts`
 * records the screen deliberately does NOT edit; and the script format is a
 * per-generation argument with no column at all. Three of five reachable, one
 * with no UI, one with nowhere to live.
 *
 * A preset is the missing noun. See
 * docs/superpowers/specs/2026-08-22-style-presets-design.md.
 *
 * ── Data in the repository, not rows ───────────────────────────────────────
 * The same choice `art-styles.ts` and `script-styles.ts` make, for the same
 * reasons: the app ships with the catalogue whether or not a seed has run, a
 * channel stores a slug rather than a copy, and improving a preset improves
 * every future video on every channel that named it. Client-safe on purpose —
 * the branding screen renders these on its first frame.
 *
 * ── A base, never a lock ───────────────────────────────────────────────────
 * A preset supplies what a look wants *before the operator says anything*. It
 * is merged UNDER the channel's own stored style, so anyone who has explicitly
 * chosen a caption mode or turned motion back on still wins. Picking a preset
 * must never silently clear a setting somebody made on purpose — which is why
 * the fields below are a starting point somebody can walk away from rather
 * than a mode that locks the screen.
 *
 * ── Two entries, because two are proven ────────────────────────────────────
 * Both describe videos that exist and were watched. Nothing here is a look
 * somebody imagined; a third should have to clear the same bar.
 */

export type StylePresetId = "insight-short" | "marker-doodle";

export interface StylePreset {
  /** Stable slug. The only thing stored on a channel, and the only thing a
   *  client ever sends — resolved against this catalogue server-side, so no
   *  request can post arbitrary render settings. */
  id: StylePresetId;
  name: string;
  /** One line: what it looks like and what it suits. Written to help an
   *  operator choose, so it names the trade-off rather than selling the look. */
  description: string;
  /** Where the pictures come from. */
  footageStyle: FootageStyle;
  /** The named look, for the styles that read one. Absent for the styles that
   *  carry their own in code — see `stylePicksArtStyle`. */
  artStyle?: ArtStyleId;
  /** Seconds one picture holds the screen, for the formats whose cadence is a
   *  channel setting. Absent means "whatever the format decides". */
  beatSeconds?: number;
  /**
   * How the script gets written, which is two different things in this app and
   * a preset has to be able to say either.
   *
   * `scriptStyleId` names a `SCRIPT_STYLES` entry — a prompt template, the
   * ordinary case. `scriptFormat` names one of the formats with its own
   * generator instead of a template: `insight` returns structured scenes
   * through a validator with retries, and there is no prompt row to point at.
   *
   * Exactly one is set. A slug, never prompt text: a preset names a script
   * style, it does not become a second script catalogue.
   */
  scriptStyleId?: string;
  scriptFormat?: "insight" | "longform";
  /** The render settings this look wants. Merged under the channel's stored
   *  `videoStyle`, section by section. */
  video: Partial<VideoStyle>;
}

export const STYLE_PRESETS: readonly StylePreset[] = [
  {
    id: "insight-short",
    name: "Insight short",
    description:
      "One idea, told in forty seconds over painterly stills, with captions that land a word at a time. The format this app's best-performing Shorts already use — and the least forgiving of a weak idea, because there is nothing else in it.",
    // Photographic rather than illustrated, and it reads no art style: this
    // format wants a different unnamed person in every shot, because the script
    // is written in the second person and a recurring face would turn "you
    // forgot the task you finished this morning" into somebody else's story.
    footageStyle: "CINEMATIC",
    // A format rather than a template: the single-insight script is generated
    // through its own structured-output path with a validator and a retry, so
    // there is no `SCRIPT_STYLES` row to name. See `ScriptFormat` in
    // script.service.ts.
    scriptFormat: "insight",
    video: {
      // One to three words landing on the spoken moment, with the stressed
      // word coloured. The whole reason this format works on a phone.
      captionMode: "kinetic",
    },
  },
  {
    id: "marker-doodle",
    name: "Marker doodle",
    description:
      "Stick figures in thick black felt-tip on off-white paper, cut hard every few seconds. Cheap, fast and unmistakable at thumbnail size, but it cannot carry mood or place — the story has to do all of it.",
    footageStyle: "DOODLE",
    artStyle: "doodle-marker",
    // The middle of the band the reference channels run at. An operator can
    // still change it; this is what they get for not having to.
    beatSeconds: 7,
    scriptStyleId: "doodle-story",
    video: {
      // Hard cuts on static frames. Both halves matter and both were measured:
      // the pan is frozen for 75.7% of adjacent frame pairs at the default
      // scale, which hides on a photograph and does not hide on a black line;
      // and a half-second dissolve between two line drawings has nothing to
      // blend, so both drawings simply stay visible.
      motion: { enabled: false, scale: 1.15 },
      transitions: { enabled: false, durationSeconds: 0.5 },
      captionMode: "kinetic",
    },
  },
];

export function findStylePreset(id: string | null | undefined): StylePreset | null {
  return STYLE_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function stylePresetLabel(id: string | null | undefined): string {
  return findStylePreset(id)?.name ?? "None chosen";
}
