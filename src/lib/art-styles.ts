/**
 * The catalogue of named art styles an illustrated channel can be drawn in.
 *
 * Data in the repository rather than rows in the database, for the reasons
 * `script-styles.ts` gives for the same choice: the app ships with the
 * catalogue whether or not a seed has run, and a channel stores a slug rather
 * than a copy of the prompt, so improving a fragment improves every future
 * video on every channel that named it. Client-safe on purpose (no
 * `server-only`) — the picker on `/channels/[id]` renders these on its first
 * frame, while `character.service.ts` and `footage.service.ts`, which compose
 * them into prompts, are both server-only.
 *
 * ── The fragment goes into both prompts, and that is the whole point ────────
 * A channel's look has to survive the join between the character sheet and the
 * scenes: the sheet is generated once and every scene is conditioned on it, so
 * a sheet painted in gouache and a scene asked for in flat vector produce a
 * fight the model resolves differently every time. `composeArtStyle` is the one
 * function both prompts call, so there is no second place the wording can drift.
 *
 * ── No living artist, no studio, ever ───────────────────────────────────────
 * Every fragment below describes a *technique* — the medium, the line quality,
 * the palette, the lighting model — and none names a person, a studio or a
 * film. That is not squeamishness. A channel whose look is "in the style of X"
 * is built on somebody else's IP and somebody else's livelihood, and it is a
 * takedown waiting to happen; it is also worse prompting, because "watercolour
 * with visible pigment granulation on cold-pressed paper" tells a model
 * something it can act on and a proper noun tells it to guess.
 *
 * ── Every entry has to hold a character ─────────────────────────────────────
 * The catalogue is short because the bar is not "does this look nice" but "can
 * the same character be recognised across a dozen generations in it". Styles
 * whose whole identity is looseness — ink wash, chalk pastel, impressionist
 * brushwork — were considered and left out: the thing that makes them
 * attractive is the thing that lets a face drift. What survives here are six
 * looks that each pin something down, whether that is a flat shape, a solid
 * form, a piece of paper or an opaque patch of paint.
 *
 * Each was verified by generating a character sheet in it and then a scene
 * conditioned on that sheet, and looking at whether it was the same character.
 */

/** A channel's chosen look, or null for "the operator has not chosen yet".
 *  Null is a real state and not a default — see `ChannelBrand.artStyle`. */
export type ArtStyleId =
  | "storybook-watercolour"
  | "flat-vector"
  | "soft-3d"
  | "cut-paper"
  | "coloured-pencil"
  | "gouache-night";

export interface ArtStyle {
  /** Stable slug. The only thing stored on a channel and the only thing a
   *  client ever sends — a style is chosen from a fixed set the server holds,
   *  so no request can post arbitrary prompt text and have it drawn. */
  id: ArtStyleId;
  /** What the picker lists. */
  name: string;
  /** One line: the look, and what it suits. Written to help an operator
   *  choose, so it names the trade-off rather than selling the style. */
  description: string;
  /**
   * The technique, as the model is told it.
   *
   * Composed verbatim into both the character-sheet prompt and every scene
   * prompt. Written as a medium plus a lighting model plus a palette, because
   * those three are what an image model can actually act on and what keeps a
   * dozen separate generations looking like one film. Colour behaviour is
   * stated in every one of them: whole-image colour drift between generations
   * is the documented artifact that stops stills intercutting, and naming the
   * palette in the prompt is the cheapest defence there is.
   */
  prompt: string;
}

export const ART_STYLES: readonly ArtStyle[] = [
  {
    id: "storybook-watercolour",
    name: "Storybook watercolour",
    description:
      "Soft washes and thick hand-drawn outlines in a warm, muted palette. The incumbent look of the bedtime-story genre and the gentlest on the eye, at the cost of being the least distinctive — a great many channels already look like this.",
    prompt:
      "Soft watercolour storybook illustration. Translucent washes with visible pigment " +
      "granulation on cold-pressed paper, thick soft hand-drawn contour lines, gentle " +
      "rounded shapes. Warm muted low-contrast palette. Diffuse ambient light with no " +
      "hard shadows.",
  },
  {
    id: "flat-vector",
    name: "Flat vector",
    description:
      "Bold flat shapes with no shading and no texture, in a small bright palette. The most reliable look here — there is almost nothing in it to drift — and the clearest on a phone, but it cannot do atmosphere.",
    prompt:
      "Flat vector illustration. Solid areas of colour with no gradients, no texture and " +
      "no rendered shading; geometric rounded shapes; outlines either uniform in weight " +
      "or absent entirely. A small bright palette of six or seven colours, repeated " +
      "exactly. Flat even light, with depth shown by overlap and scale rather than by " +
      "shadow.",
  },
  {
    id: "soft-3d",
    name: "Soft 3D toy",
    description:
      "Rounded matte-clay figures under soft studio light, like a stop-motion set. Reads as modern preschool animation and holds a character unusually well, because the forms are simple solids seen in the round.",
    prompt:
      "Soft 3D render with a matte modelling-clay finish. Rounded chunky forms with " +
      "slightly imperfect hand-shaped surfaces and faint fingerprint texture; no glossy " +
      "highlights and no hard reflections. Large soft studio light source, gentle " +
      "wraparound shadows, shallow depth of field. Warm, slightly desaturated palette.",
  },
  {
    id: "cut-paper",
    name: "Cut-paper collage",
    description:
      "Layered paper shapes with torn fibre edges and small drop shadows. The most distinctive look on this list at a glance, and stable for the same reason flat vector is: a character is a handful of flat pieces.",
    prompt:
      "Cut-paper collage illustration. Every element is a separate piece of coloured " +
      "construction paper — some scissor-cut with clean edges, some torn to show white " +
      "fibres — layered in planes with small soft drop shadows between them. Visible " +
      "paper grain throughout. Matte, slightly chalky colours. Flat, frontal, " +
      "shallow-stage composition.",
  },
  {
    id: "coloured-pencil",
    name: "Coloured pencil",
    description:
      "Waxy strokes over visible paper tooth, with a hand-drawn wobble to the line. Warmer and more homemade than watercolour; best for small everyday stories, and the weakest of these at anything with scale or drama.",
    prompt:
      "Coloured pencil illustration on textured paper. Visible directional strokes and " +
      "cross-hatching, waxy build-up in the darker passages, paper tooth showing through " +
      "the lighter ones. Slightly wobbly hand-drawn contour lines. Soft natural palette. " +
      "No digital smoothness and no gradients.",
  },
  {
    id: "gouache-night",
    name: "Gouache night",
    description:
      "Opaque matte paint in deep indigos and plums, lifted by pooled lamplight. Built for bedtime and sleep stories, which is where most of this genre's watch time is — and unusable for anything set in daylight.",
    prompt:
      "Opaque gouache painting. Flat matte paint laid in visible brush-shaped patches " +
      "with no translucency and crisp edges where colours meet. A deep night palette of " +
      "indigo, plum and slate, lifted by small pools of warm amber light from lamps, " +
      "candles or the moon, each with a soft glow around it. Calm and quiet; nothing " +
      "harsh, nothing frightening.",
  },
];

export function findArtStyle(id: string | null | undefined): ArtStyle | null {
  return ART_STYLES.find((style) => style.id === id) ?? null;
}

/** Short label for a card, where there is room for two or three words. */
export function artStyleLabel(id: string | null | undefined): string {
  return findArtStyle(id)?.name ?? "None chosen";
}

/**
 * The art direction every illustrated prompt carries, whichever style is
 * chosen.
 *
 * Two parts, and the split is deliberate. The style's own fragment is the look;
 * this is the brief the look is applied to, and it is identical for all six —
 * a children's picture book, nothing frightening, no lettering. Keeping the
 * invariant half out of the catalogue means a new style cannot accidentally
 * drop it, and means the six entries differ only in the thing they are
 * supposed to differ in.
 *
 * "No text" is repeated here and again at each call site on purpose. A model
 * handed a picture-book brief writes words into the picture given the slightest
 * excuse, and a misspelled word burnt into a children's video is exactly the
 * defect YouTube's kids quality principles single out as "deceptively
 * educational".
 */
const SHARED_DIRECTION =
  "Illustration for a children's picture book. Nothing frightening, nothing " +
  "sharp, nothing photoreal. No text, no words, no letters, no captions, no " +
  "labels and no watermark anywhere in the image.";

/**
 * The complete art direction for a channel, as both prompts state it.
 *
 * The one function the character sheet and every scene both call — see this
 * module's own doc comment for why that matters more than what it returns.
 * Refuses nothing: a caller with no style has already been refused upstream
 * (`CharacterService.generateSheet` and `FootageService.collectIllustrated`
 * both check), and falling back to a default look here would silently give
 * every channel that forgot the same one, which is the opposite of the feature.
 */
export function composeArtStyle(style: ArtStyle): string {
  return `${SHARED_DIRECTION}\n\n${style.prompt}`;
}
