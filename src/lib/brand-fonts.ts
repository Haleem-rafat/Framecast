/**
 * The fonts a channel is allowed to pick, which is exactly the set installed
 * in the render worker's image — no more, and never free text.
 *
 * This is not a style preference dressed up as a constraint. `headlineFont`
 * reaches FFmpeg twice: `drawtext` resolves it by name when the thumbnail
 * headline is burned in (see `buildThumbnailArgs` in thumbnail-command.ts),
 * and libass resolves the caption face the same way when the subtitles are
 * burned into the video. Both of them fall back to a default face *silently*
 * on a name they cannot resolve — no warning, no failed render, no log line.
 * An operator who typed "Montserrat" would get a video that looks exactly
 * like a channel that never set a font, and nothing anywhere would say why.
 * So the picker offers what the image actually has, and the schema refuses
 * anything else.
 *
 * The source of truth is worker/Dockerfile, which installs
 * `fonts-dejavu-core` and nothing else, and then asserts at build time that
 * `/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf` exists. That package
 * ships six files — Sans, Serif and Sans Mono, each regular and bold — which
 * fontconfig reports as the three families below (`fc-list : family` inside
 * `ghcr.io/haleem-rafat/framecast-worker:latest` returns exactly these three).
 * Bold is a style within a family, not a family, so it is not a fourth
 * option: neither drawtext nor libass is asked for a weight here.
 *
 * A plain client-safe module for the same reason `footage-styles.ts` and
 * `youtube-audience.ts` are: the picker that edits this is a client component
 * and these are strings it renders on its first frame, while the services
 * that consume the value are `server-only`.
 *
 * Adding a font means adding it to worker/Dockerfile *first* and rebuilding
 * the worker image. An entry here that the image does not have is worse than
 * no entry at all — it is the silent fallback above, promised by a UI.
 */

export interface BrandFont {
  /** Stored verbatim, and handed to drawtext and libass verbatim. */
  value: string;
  label: string;
  /**
   * What to preview it with in the operator's browser, which almost certainly
   * does not have DejaVu installed — macOS ships none of it. The real face is
   * named first so a Linux operator sees the truth, then the generic family
   * DejaVu belongs to, so everyone else sees the right *shape* rather than
   * whatever the page font happens to be.
   */
  previewStack: string;
  /** What it reads like, so the choice is not made on the name alone. */
  description: string;
}

/** Mirrors `BrandService`'s own FALLBACK and `DEFAULT_STYLE.captions.fontName`.
 *  All three have to agree: a channel that has never been branded and a
 *  channel branded before this screen existed must render identically. */
export const DEFAULT_HEADLINE_FONT = "DejaVu Sans";

export const BRAND_FONTS: readonly BrandFont[] = [
  {
    value: "DejaVu Sans",
    label: "DejaVu Sans",
    previewStack: '"DejaVu Sans", Verdana, sans-serif',
    description:
      "The default. Wide, even letterforms that stay legible at thumbnail size and behind busy footage.",
  },
  {
    value: "DejaVu Serif",
    label: "DejaVu Serif",
    previewStack: '"DejaVu Serif", Georgia, serif',
    description:
      "Bookish and slower to read at a glance. Suits explainers and history over news and how-to.",
  },
  {
    value: "DejaVu Sans Mono",
    label: "DejaVu Sans Mono",
    previewStack: '"DejaVu Sans Mono", "SFMono-Regular", monospace',
    description:
      "Fixed width. Reads as technical, and eats horizontal room — a long headline shrinks to fit.",
  },
  {
    value: "Inter Black",
    label: "Inter Black",
    previewStack: '"Inter Black", "Inter", "Helvetica Neue", sans-serif',
    description:
      "The heaviest face here. Built for two or three words filling the frame, not for a sentence — a long headline in it is a wall.",
  },
];

/**
 * The face word-by-word captions are set in.
 *
 * A separate constant from `DEFAULT_HEADLINE_FONT` because the two answer
 * different questions. A headline sits on a thumbnail and can afford a serif or
 * a mono; a caption burned over moving footage at one to three words a time has
 * one job, which is to be readable in a quarter of a second on a phone held at
 * arm's length. DejaVu Sans has no weight above Bold and loses that fight.
 *
 * Verified present in the worker image — see the `fc-list` assertion in
 * worker/Dockerfile, which fails the build rather than letting libass fall back
 * silently.
 */
export const KINETIC_CAPTION_FONT = "Inter Black";

/** The preview stack for a stored value, falling back to the default's rather
 *  than to nothing: a row written before this list existed may name a face
 *  that is not on it, and a preview with no font is a preview of the page. */
export function brandFontStack(value: string): string {
  return (
    BRAND_FONTS.find((font) => font.value === value)?.previewStack ??
    BRAND_FONTS[0].previewStack
  );
}
