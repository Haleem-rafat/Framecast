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
 *  mjpeg encoder's yuvj420p output needs an even width. */
const LOGO_HEIGHT = 96;
const LOGO_MARGIN = 24;

const HEADLINE_MAX_FONT_SIZE = 72;
const HEADLINE_MIN_FONT_SIZE = 28;
const HEADLINE_SIDE_MARGIN = 40;
const HEADLINE_MARGIN_BOTTOM = 56;
const HEADLINE_BOX_PAD = 24;

/**
 * `drawtext` can't size itself to fit — `fontsize` has to be a plain number
 * before the filter can measure the string it produces, so an expression
 * referencing the rendered width doesn't exist. Left at a fixed size, a
 * realistic headline runs off both edges of the frame: a 45-character
 * headline at 72px overflowed 1280px by roughly 20% in a rendered check
 * against real ffmpeg, cutting off whole words rather than just looking
 * cramped. This estimates a size that keeps the string inside the frame
 * instead, using an average glyph width for DejaVu Sans calibrated from
 * that same rendered check (~0.5 x fontsize per character; deliberately on
 * the wide side so it undershoots into "smaller than necessary" rather than
 * overshoots back into cut-off text).
 */
function computeHeadlineFontSize(headline: string): number {
  const availableWidth = THUMBNAIL_WIDTH - HEADLINE_SIDE_MARGIN * 2;
  const charCount = Math.max(headline.length, 1);
  const fitted = Math.floor(availableWidth / (charCount * 0.5));

  return Math.min(HEADLINE_MAX_FONT_SIZE, Math.max(HEADLINE_MIN_FONT_SIZE, fitted));
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
 * Verified against a real `ffmpeg` binary with a headline containing a
 * colon, a comma, an apostrophe and brackets together; single-pass escaping
 * (the more obvious-looking fix) reproducibly breaks the colon case.
 */
function escapeDrawtextValue(value: string): string {
  const pass1 = value.replace(/([\\':])/g, "\\$1");
  return pass1.replace(/([\\',;[\]])/g, "\\$1");
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
 * whatever this returns, so every path here still needs filter-graph
 * escaping even though it never passes through a shell (see
 * `escapeDrawtextValue` above and `escapeForFilter` in ffmpeg-command.ts).
 */
export function buildThumbnailArgs(input: ThumbnailInput): string[] {
  const headlineFilter =
    `drawtext=font=${escapeDrawtextValue(input.brand.headlineFont)}:` +
    // `drawtext`'s `text` option has a third parser on top of the two
    // `escapeDrawtextValue` handles: with the default `expansion=normal`,
    // drawtext itself reads a literal `%` as the start of a `%{...}`
    // sequence (e.g. `%{pts}`), and the documented escape for a literal
    // percent — doubling it to `%%` — does not survive contact with this
    // filter in practice. Verified against a real `ffmpeg` (8.0.1) binary:
    // `text=40%% problem` still logs `Stray %` and silently drops the whole
    // string, the same failure a headline like "Down 40%" would hit
    // unescaped. `expansion=none` turns the sub-parser off instead of
    // trying to satisfy it, which makes `%` an ordinary character that
    // needs no escaping of its own below.
    "expansion=none:" +
    `text=${escapeDrawtextValue(input.headline)}:` +
    `fontsize=${computeHeadlineFontSize(input.headline)}:` +
    `fontcolor=${input.brand.primaryColour}:` +
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

  let outputLabel = "[bg]";

  if (input.logoPath) {
    // `movie=` pulls a second file into the graph as its own source filter,
    // so the watermark needs no second `-i` and the whole composite still
    // fits in one `-vf` simple filtergraph.
    chains.push(`movie=${escapeDrawtextValue(input.logoPath)},scale=-2:${LOGO_HEIGHT}[logo]`);
    chains.push(`[bg][logo]overlay=W-w-${LOGO_MARGIN}:H-h-${LOGO_MARGIN}[out]`);
    outputLabel = "[out]";
  }

  // A single chain needs no trailing label — its output is already the
  // graph's output. With a logo there are three chains, so the last one must
  // be named and referenced, or FFmpeg can't tell which pad is the result.
  const videoFilter =
    outputLabel === "[bg]"
      ? chains[0].replace(/\[bg\]$/, "")
      : `${chains.join(";")}`;

  return [
    "-y",
    "-i", input.imagePath,
    "-vf", videoFilter,
    "-frames:v", "1",
    "-q:v", JPEG_QUALITY,
    input.outputPath,
  ];
}
