import type { ResolvedBrand } from "@/services/brand.service";

/** YouTube's thumbnail spec. Anything else gets letterboxed or rejected on
 *  upload, so the crop below is not a style choice. */
export const THUMBNAIL_WIDTH = 1280;
export const THUMBNAIL_HEIGHT = 720;

/** `-q:v` for the mjpeg encoder, 2 (best) to 31 (worst) — not a percentage.
 *  4 is visually close to lossless at this resolution and lands a frame in
 *  the low hundreds of KB, comfortably under YouTube's 2MB cap with room to
 *  spare for busy source images. */
const JPEG_QUALITY = "4";

/** Logo height in the corner watermark. Width follows from the source's own
 *  aspect ratio via `scale=-2:HEIGHT` — `-2` rather than `-1` because the
 *  mjpeg encoder's yuvj420p output needs an even width. Anchored to the top
 *  corner deliberately: the headline is bottom-anchored (see
 *  `HEADLINE_MARGIN_BOTTOM`), and a fixed-size logo sharing the bottom edge
 *  with a variable-length headline has no guaranteed gap between them —
 *  putting the two in opposite corners removes the collision instead of
 *  computing around it. */
const LOGO_HEIGHT = 96;
const LOGO_MARGIN = 24;

export const HEADLINE_MAX_FONT_SIZE = 72;
export const HEADLINE_MIN_FONT_SIZE = 28;
const HEADLINE_SIDE_MARGIN = 40;
const HEADLINE_MARGIN_BOTTOM = 56;
const HEADLINE_BOX_PAD = 24;

/**
 * `drawtext`'s box (see `box=1` at the call site) draws `boxborderw` pixels
 * of padding on every side of the measured text, so the box — not the text
 * — is what has to stay inside the frame: total on-screen width is
 * `text_w + 2 * HEADLINE_BOX_PAD`. Leaving the box padding out of this
 * budget was the bug in the first version of this heuristic: it sized text
 * to fill the full `THUMBNAIL_WIDTH - 2 * HEADLINE_SIDE_MARGIN`, so the box
 * always overflowed by `2 * HEADLINE_BOX_PAD` (48px) as soon as the text
 * estimate was even slightly optimistic — which it reliably was, below.
 */
const HEADLINE_TEXT_BUDGET =
  THUMBNAIL_WIDTH - HEADLINE_SIDE_MARGIN * 2 - HEADLINE_BOX_PAD * 2;

/**
 * Average glyph width for DejaVu Sans as a fraction of `fontsize`, measured
 * by rendering and reading pixels back with real ffmpeg. Lowercase text
 * measures close to 0.50, Title Case close to 0.53, but headlines routinely
 * arrive upper-cased ("BREAKING: ..."), which measures closer to 0.62 —
 * using the lowercase figure here undersells the box by as much as 24%
 * against a margin that, once `HEADLINE_TEXT_BUDGET` accounted for the box
 * padding, is only a few percent wide. The fix is to size for the widest
 * case FFmpeg will actually see, not the most common one.
 */
const HEADLINE_CHAR_WIDTH_RATIO = 0.62;

/** How many characters fit at a given font size without the box exceeding
 *  `HEADLINE_TEXT_BUDGET`. `Math.floor` is load-bearing, not cosmetic: it is
 *  what makes `fitHeadline` a guarantee rather than an estimate — rounding
 *  the *character count* down can only under-fill the budget, never exceed
 *  it, however the division comes out. */
function maxCharsAtFontSize(fontSize: number): number {
  return Math.floor(HEADLINE_TEXT_BUDGET / (fontSize * HEADLINE_CHAR_WIDTH_RATIO));
}

export interface FittedHeadline {
  /** The headline as it will actually be drawn — unchanged unless even
   *  `HEADLINE_MIN_FONT_SIZE` can't hold the whole string. */
  text: string;
  fontSize: number;
}

/**
 * Chooses a font size the headline's box is guaranteed to fit inside at
 * `THUMBNAIL_WIDTH`, shrinking down to `HEADLINE_MIN_FONT_SIZE` before
 * giving up on the full string.
 *
 * The previous version clamped an undersized fit back up to
 * `HEADLINE_MIN_FONT_SIZE` with `Math.max`, which defeats the fit guarantee
 * for exactly the headlines that need one most: a long headline was
 * measured as needing a smaller size, then forced back to a bigger one
 * that reliably overflows the frame. `drawtext` can't wrap or shrink text
 * on its own — `fontsize` is a plain number fixed before the filter can
 * measure anything — so once the minimum readable size still doesn't fit,
 * the only options are to overflow the frame or to draw less text. This
 * truncates with an ellipsis rather than the former.
 */
export function fitHeadline(headline: string): FittedHeadline {
  const charCount = Math.max(headline.length, 1);

  if (charCount <= maxCharsAtFontSize(HEADLINE_MAX_FONT_SIZE)) {
    return { text: headline, fontSize: HEADLINE_MAX_FONT_SIZE };
  }

  const fitted = Math.floor(HEADLINE_TEXT_BUDGET / (charCount * HEADLINE_CHAR_WIDTH_RATIO));

  if (fitted >= HEADLINE_MIN_FONT_SIZE) {
    return { text: headline, fontSize: fitted };
  }

  const maxChars = Math.max(maxCharsAtFontSize(HEADLINE_MIN_FONT_SIZE), 1);
  const truncated = headline.slice(0, Math.max(maxChars - 1, 1)).trimEnd();

  return { text: `${truncated}…`, fontSize: HEADLINE_MIN_FONT_SIZE };
}

/**
 * FFmpeg re-parses a filter-graph string in two passes, and each pass owns a
 * different set of special characters — see the "Notes on filtergraph
 * escaping" section of the FFmpeg documentation, which works this exact
 * example. Getting only one pass right is worse than getting neither right,
 * because the first pass silently strips the backslash meant for the
 * second: a value escaped for one level only comes apart when FFmpeg reads
 * it, rather than failing loudly.
 *
 * Pass 1 belongs to the filter's own option list, which drawtext splits on
 * unescaped `:` (and uses `\`/`'` as its escape and quote characters) — a
 * headline's colon needs `\:` here or it silently ends the `text` option.
 *
 * Pass 2 belongs to the filter-graph description that this option list is
 * embedded in, which is split on unescaped `,` (ends a filter), `;` (ends a
 * chain) and `[`/`]` (link labels), and which *also* treats `\`/`'` as its
 * escape/quote characters. Because pass 2 reads the string pass 1 produced,
 * anything pass 1 already escaped (`\` or `'`) needs re-escaping here too, or
 * pass 2 consumes the backslash meant for pass 1 before drawtext ever sees
 * it — which is exactly the bare-colon failure this function exists to
 * avoid. `,`/`;`/`[`/`]` are new at this level and get a single backslash.
 *
 * Verified against real ffmpeg (5.1.10, the render worker's version, and
 * 8.0.1) with a headline containing a colon, a comma, an apostrophe and
 * brackets together, read back byte-exact on both; single-pass escaping
 * (the more obvious-looking fix) reproducibly breaks the colon case.
 *
 * Apply this to any value this module embeds in the `-vf` graph — headline
 * text, the brand's font name, the logo path — and only those. `imagePath`
 * and `outputPath` below are separate `-i`/output argv entries FFmpeg's
 * filter-graph parser never reads, so running them through this would
 * mangle the path itself rather than protect it.
 */
function escapeDrawtextValue(value: string): string {
  const pass1 = value.replace(/([\\':])/g, "\\$1");
  return pass1.replace(/([\\',;[\]])/g, "\\$1");
}

const DEFAULT_HEADLINE_COLOUR = "#FFFFFF";
const HEX_COLOUR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * `ResolvedBrand.primaryColour` is an unvalidated `String?` column — nothing
 * upstream of this module constrains what a channel row can hold. Escaping
 * it the way headline text is escaped would stop it from *breaking* the
 * filter graph, but a value like `white:x=0` would still parse as valid
 * FFmpeg syntax that happens to add its own drawtext options. A strict
 * allowlist closes that off instead of trying to sanitise around it: only a
 * plain 6-digit hex colour is used as-is, anything else falls back to a
 * known-safe default.
 */
function resolveHeadlineColour(colour: string): string {
  return HEX_COLOUR_PATTERN.test(colour) ? colour : DEFAULT_HEADLINE_COLOUR;
}

export interface ThumbnailInput {
  imagePath: string;
  outputPath: string;
  headline: string;
  brand: Pick<ResolvedBrand, "primaryColour" | "headlineFont">;
  logoPath?: string | null;
}

/**
 * Builds the argument array for compositing one AI-generated thumbnail
 * image: scale/crop it to YouTube's 1280x720, burn in the headline (image
 * models render text unreliably, so it is never left to the model), overlay
 * the channel's logo when there is one, and encode a JPEG under the 2MB cap.
 *
 * Pure — no filesystem, network or process access. Task 7 spawns FFmpeg with
 * whatever this returns.
 */
export function buildThumbnailArgs(input: ThumbnailInput): string[] {
  const headline = fitHeadline(input.headline);

  const headlineFilter =
    `drawtext=font=${escapeDrawtextValue(input.brand.headlineFont)}:` +
    // `drawtext`'s `text` option has a third parser on top of the two
    // `escapeDrawtextValue` handles: with the default `expansion=normal`,
    // drawtext itself reads a literal `%` as the start of a `%{...}`
    // sequence (e.g. `%{pts}`), and the documented escape for a literal
    // percent — doubling it to `%%` — does not survive contact with this
    // filter in practice, on either ffmpeg version this module has been
    // checked against: `text=40%% problem` still logs `Stray %` and
    // silently drops the whole string, the same failure a headline like
    // "Down 40%" would hit unescaped. `expansion=none` turns the
    // sub-parser off instead of trying to satisfy it, which makes `%` an
    // ordinary character that needs no escaping of its own below.
    "expansion=none:" +
    `text=${escapeDrawtextValue(headline.text)}:` +
    `fontsize=${headline.fontSize}:` +
    `fontcolor=${resolveHeadlineColour(input.brand.primaryColour)}:` +
    // A box behind the text rather than relying on the brand colour to
    // contrast with the image — the image is AI-generated and unpredictable,
    // but black-at-60%-opacity reads under any picture.
    "box=1:boxcolor=black@0.6:" +
    `boxborderw=${HEADLINE_BOX_PAD}:` +
    "x=(w-text_w)/2:" +
    `y=h-th-${HEADLINE_MARGIN_BOTTOM}`;

  const chains = [
    `scale=${THUMBNAIL_WIDTH}:${THUMBNAIL_HEIGHT}:force_original_aspect_ratio=increase,` +
      `crop=${THUMBNAIL_WIDTH}:${THUMBNAIL_HEIGHT},` +
      `${headlineFilter}[bg]`,
  ];

  const hasLogo = Boolean(input.logoPath);

  if (input.logoPath) {
    // `movie=` pulls a second file into the graph as its own source filter,
    // so the watermark needs no second `-i` and the whole composite still
    // fits in one `-vf` simple filtergraph. Top-right, not bottom — see the
    // comment on LOGO_MARGIN for why it shares no edge with the headline.
    chains.push(`movie=${escapeDrawtextValue(input.logoPath)},scale=-2:${LOGO_HEIGHT}[logo]`);
    chains.push(`[bg][logo]overlay=W-w-${LOGO_MARGIN}:${LOGO_MARGIN}[out]`);
  }

  // A single chain needs no trailing label — its output is already the
  // graph's output. With a logo there are three chains, so the last one must
  // be named and referenced, or FFmpeg can't tell which pad is the result.
  const videoFilter = hasLogo ? chains.join(";") : chains[0].replace(/\[bg\]$/, "");

  return [
    "-y",
    "-i", input.imagePath,
    "-vf", videoFilter,
    "-frames:v", "1",
    "-q:v", JPEG_QUALITY,
    input.outputPath,
  ];
}
