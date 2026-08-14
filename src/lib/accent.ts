import type { AccentColour } from "@/generated/prisma/enums";

/**
 * The operator's accent colour, and the proof that every one of them is
 * readable.
 *
 * ---------------------------------------------------------------------------
 * Why a curated set and not a colour picker
 * ---------------------------------------------------------------------------
 * An accent is not decoration. It lands on `--primary`, which is a solid fill
 * with `--primary-foreground` text on top of it, and on `--ring`, which is the
 * only thing telling a keyboard user where they are. Both are load-bearing, so
 * both have to clear WCAG contrast — 4.5:1 for the text on a button, 3:1 for a
 * focus ring against the page it sits on.
 *
 * A single stored colour cannot satisfy that in both themes. The studio's light
 * ground is white and its dark ground is oklch(0.145 0 0); a colour light enough
 * to carry near-black text on dark is far too light to carry near-white text on
 * light. So an accent is not one colour, it is a *pair* derived per theme:
 * darker on light, lighter on dark. That is the same derivation `.marketing`
 * does by hand in globals.css, generalised.
 *
 * Doing that derivation for an arbitrary hex the operator types means solving
 * for lightness at input time, on every save, and then either refusing their
 * colour or silently returning a different one — a picker whose answer to
 * "I chose #FFFF00" is "no" or "here is #8B6802 instead" is a worse control
 * than a grid of swatches. Windows 11, which is the reference for this feature,
 * ships exactly such a grid. Ten hues plus the monochrome default is enough
 * range that people find one they like, and small enough that every pair below
 * could be solved, measured and frozen once.
 *
 * ---------------------------------------------------------------------------
 * How the pairs were derived
 * ---------------------------------------------------------------------------
 * For each hue, chroma was pushed as far as the sRGB gamut allows and lightness
 * was solved numerically against the *fixed* foregrounds the studio already
 * uses — oklch(0.985 0 0) on light, oklch(0.205 0 0) on dark — for the extreme
 * that still clears 4.5:1, then backed off 0.04 in L so rounding to three
 * decimals can never drift under the line. Every pair lands at 5.28:1–5.36:1,
 * and `accent.test.ts` recomputes all of them from the numbers below rather
 * than trusting this paragraph.
 *
 * `--destructive` is deliberately absent from every entry. Red means "this
 * deletes something" in this studio and it has to keep meaning that whatever
 * the operator's accent is, including when the accent is itself ROSE — meaning
 * is never carried by the accent alone.
 */

/** L, C, H in oklch. Stored structured so contrast can be computed on it. */
export type Oklch = readonly [lightness: number, chroma: number, hue: number];

/** The five tokens an accent replaces, for one theme. */
export interface AccentTheme {
  /** `--primary` / `--sidebar-primary`: solid button and active sidebar fill. */
  primary: Oklch;
  /** `--primary-foreground`: what sits *on* the fill. Measured against it. */
  primaryForeground: Oklch;
  /** `--ring`: the focus indicator. Measured against the page background. */
  ring: Oklch;
  /** `--accent` / `--sidebar-accent`: the hover and selected surface. */
  surface: Oklch;
  /** `--accent-foreground`: text on that surface. Measured against it. */
  surfaceForeground: Oklch;
}

export interface AccentDefinition {
  /** Shown under the swatch. */
  label: string;
  light: AccentTheme;
  dark: AccentTheme;
}

/**
 * WCAG 2.2 AA: 4.5:1 for normal-size text, which is what a button label is.
 * Buttons are not large text — `size-default` is 14px at weight 500, under the
 * 18.66px/bold threshold that would let 3:1 through.
 */
export const MIN_TEXT_CONTRAST = 4.5;

/** WCAG 2.2 SC 1.4.11: non-text UI, which is what a focus ring is. */
export const MIN_NON_TEXT_CONTRAST = 3;

/** The page behind a focus ring, per theme — `--background` from globals.css. */
export const STUDIO_BACKGROUND: Record<"light" | "dark", Oklch> = {
  light: [1, 0, 0],
  dark: [0.145, 0, 0],
};

/**
 * GRAPHITE's tokens are copied from globals.css rather than chosen here, and
 * nothing emits them — `accentStyleSheet` returns "" for GRAPHITE precisely so
 * that the default operator's studio is byte-for-byte the studio that shipped
 * before this feature existed. They are recorded because the swatch has to show
 * *something*, and because the contrast audit should not have a hole in it
 * where the default is.
 */
const GRAPHITE: AccentDefinition = {
  label: "Graphite",
  light: {
    primary: [0.205, 0, 0],
    primaryForeground: [0.985, 0, 0],
    ring: [0.708, 0, 0],
    surface: [0.97, 0, 0],
    surfaceForeground: [0.205, 0, 0],
  },
  dark: {
    primary: [0.922, 0, 0],
    primaryForeground: [0.205, 0, 0],
    ring: [0.556, 0, 0],
    surface: [0.269, 0, 0],
    surfaceForeground: [0.985, 0, 0],
  },
};

/**
 * Builds one accent from its solved pair. Only the four numbers that differ per
 * accent are arguments; everything structural — the near-white and near-black
 * foregrounds, and the barely-tinted hover surfaces — is the same shape for all
 * ten, so stating it once is what keeps the ten from drifting apart.
 *
 * The hover surface deserves a word. shadcn's `--accent` is a *background*
 * (dropdown hover, selected sidebar row), not the brand colour, so it is tinted
 * rather than saturated: chroma is scaled down to roughly a tenth of the fill's
 * on light and a fifth on dark. That reads as "this row belongs to my accent"
 * without turning every menu into a block of colour, and it leaves the pairing
 * with `surfaceForeground` at 12:1 or better, far clear of the line.
 */
function accent(
  label: string,
  hue: number,
  light: { l: number; c: number },
  dark: { l: number; c: number },
  /** Chroma of the *nominal* hue, before gamut clipping — scales the tints. */
  nominalChroma: number,
): AccentDefinition {
  const round = (n: number) => Number(n.toFixed(3));

  return {
    label,
    light: {
      primary: [light.l, light.c, hue],
      // Unchanged from globals.css's light `--primary-foreground`, but restated
      // rather than inherited: the 5.3:1 measured below is a property of *this
      // pair*, and inheriting one half of it would let an unrelated edit to
      // globals.css silently invalidate a number this file claims to guarantee.
      primaryForeground: [0.985, 0, 0],
      ring: [light.l, light.c, hue],
      surface: [0.965, round(nominalChroma * 0.07), hue],
      surfaceForeground: [0.3, round(nominalChroma * 0.35), hue],
    },
    dark: {
      primary: [dark.l, dark.c, hue],
      primaryForeground: [0.205, 0, 0],
      ring: [dark.l, dark.c, hue],
      surface: [0.285, round(nominalChroma * 0.18), hue],
      surfaceForeground: [0.965, round(nominalChroma * 0.06), hue],
    },
  };
}

/**
 * Every accent, in the order the picker shows them: the monochrome default
 * first, then the ten hues around the wheel from blue to teal, so the grid
 * reads as a spectrum rather than an arbitrary pile.
 *
 * Typed as `Record<AccentColour, …>` on purpose — adding a member to the Prisma
 * enum without adding it here is a compile error, not a runtime hole where the
 * studio silently renders monochrome for that value.
 */
export const ACCENTS: Record<AccentColour, AccentDefinition> = {
  GRAPHITE,
  BLUE: accent("Blue", 250, { l: 0.517, c: 0.145 }, { l: 0.639, c: 0.18 }, 0.18),
  INDIGO: accent("Indigo", 285, { l: 0.534, c: 0.19 }, { l: 0.655, c: 0.19 }, 0.19),
  VIOLET: accent("Violet", 305, { l: 0.54, c: 0.2 }, { l: 0.661, c: 0.2 }, 0.2),
  PLUM: accent("Plum", 330, { l: 0.543, c: 0.2 }, { l: 0.664, c: 0.2 }, 0.2),
  // Hue 0 is a pink-leaning red, two thirds of the wheel away from
  // `--destructive`'s orange-red 27.3. Distinct enough that a Save button in
  // ROSE is not mistaken for a Delete button, and the two are never the only
  // difference between two controls anyway — see the module comment.
  ROSE: accent("Rose", 0, { l: 0.541, c: 0.18 }, { l: 0.662, c: 0.18 }, 0.18),
  ORANGE: accent("Orange", 55, { l: 0.529, c: 0.13 }, { l: 0.651, c: 0.16 }, 0.17),
  AMBER: accent("Amber", 85, { l: 0.519, c: 0.105 }, { l: 0.641, c: 0.13 }, 0.16),
  LIME: accent("Lime", 135, { l: 0.504, c: 0.145 }, { l: 0.624, c: 0.18 }, 0.19),
  EMERALD: accent("Emerald", 160, { l: 0.503, c: 0.11 }, { l: 0.623, c: 0.14 }, 0.16),
  TEAL: accent("Teal", 195, { l: 0.507, c: 0.085 }, { l: 0.627, c: 0.105 }, 0.13),
};

/** Mirrors the column default in prisma/schema.prisma. */
export const DEFAULT_ACCENT: AccentColour = "GRAPHITE";

/**
 * The id of the `<style>` element the dashboard layout server-renders with the
 * operator's accent in it.
 *
 * It lives here, next to the function that fills that element, because the
 * settings picker's live preview works by rewriting exactly this element's text
 * — that is the *only* way to repaint the studio without a round trip, since
 * the accent is not a class on some wrapper but a set of custom properties on
 * `:root`. One constant, two call sites, no chance of a typo silently turning
 * the preview into a no-op.
 */
export const ACCENT_STYLE_ID = "framecast-accent";

/**
 * Ordered for the picker. Derived from `ACCENTS` rather than written out again,
 * so the grid can never disagree with the palette about what exists.
 */
export const ACCENT_ORDER = Object.keys(ACCENTS) as AccentColour[];

/**
 * The accent arrives from a database column typed by an enum, so in practice it
 * is always valid — but this file also renders CSS, and a value that fell
 * through from an older row or a hand-edited record must degrade to the
 * monochrome default rather than produce `oklch(undefined)`.
 */
export function isAccentColour(value: unknown): value is AccentColour {
  return typeof value === "string" && value in ACCENTS;
}

export function resolveAccent(value: unknown): AccentColour {
  return isAccentColour(value) ? value : DEFAULT_ACCENT;
}

/** `[0.517, 0.145, 250]` → `oklch(0.517 0.145 250)`. */
export function formatOklch([l, c, h]: Oklch): string {
  return `oklch(${l} ${c} ${h})`;
}

// ---------------------------------------------------------------------------
// Contrast
// ---------------------------------------------------------------------------

/**
 * oklch → linear-light sRGB, via oklab and the LMS cone response.
 *
 * The return value is deliberately *linear* and deliberately unclamped. Linear
 * is what WCAG's relative luminance formula wants, so the usual gamma-encode /
 * gamma-decode round trip would be two lossy steps that cancel. Unclamped is so
 * `isInGamut` can tell "this oklch has no sRGB equivalent" from "this oklch is
 * black", which clamping would erase.
 *
 * Coefficients are Björn Ottosson's published oklab matrices.
 */
export function oklchToLinearSrgb([L, C, hDeg]: Oklch): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const lCone = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mCone = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sCone = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    4.0767416621 * lCone - 3.3077115913 * mCone + 0.2309699292 * sCone,
    -1.2684380046 * lCone + 2.6097574011 * mCone - 0.3413193965 * sCone,
    -0.0041960863 * lCone - 0.7034186147 * mCone + 1.707614701 * sCone,
  ];
}

/**
 * Whether a colour actually exists in sRGB. An out-of-gamut oklch still renders
 * — the browser clips it — but it renders as a *different* colour than the one
 * whose contrast was computed, which would make every ratio in this file a
 * claim about a colour nobody sees. The tolerance absorbs float error at the
 * exact gamut boundary.
 */
export function isInGamut(colour: Oklch): boolean {
  return oklchToLinearSrgb(colour).every(
    (channel) => channel >= -1e-4 && channel <= 1 + 1e-4,
  );
}

/** WCAG 2.2 relative luminance. Input is clamped because a display clips too. */
export function relativeLuminance(colour: Oklch): number {
  const [r, g, b] = oklchToLinearSrgb(colour).map((channel) =>
    Math.min(1, Math.max(0, channel)),
  );

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.2 contrast ratio. Symmetric — argument order does not matter. */
export function contrastRatio(a: Oklch, b: Oklch): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);

  return (
    (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
  );
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

/**
 * The tokens an accent overrides, in the order they are written.
 *
 * `--primary-foreground` and `--sidebar-primary-foreground` are in the list
 * even where their value equals globals.css's, because the dark sidebar's is
 * *not* equal: globals.css sets `--sidebar-primary-foreground: oklch(0.985 0 0)`
 * — near-white — over a `--sidebar-primary` that is a near-white blue. Left
 * alone, an accented dark sidebar would put white text on a light accent, which
 * is the exact unreadable outcome this whole file exists to prevent.
 *
 * `--chart-*` is not in the list. Charts encode series identity in colour, and
 * repainting every series in one hue would destroy the only thing separating
 * them. Neither is `--destructive`: see the module comment.
 */
function declarations(theme: AccentTheme): string {
  const { primary, primaryForeground, ring, surface, surfaceForeground } = theme;

  const tokens: ReadonlyArray<readonly [string, Oklch]> = [
    ["--primary", primary],
    ["--primary-foreground", primaryForeground],
    ["--ring", ring],
    ["--accent", surface],
    ["--accent-foreground", surfaceForeground],
    ["--sidebar-primary", primary],
    ["--sidebar-primary-foreground", primaryForeground],
    ["--sidebar-accent", surface],
    ["--sidebar-accent-foreground", surfaceForeground],
    ["--sidebar-ring", ring],
  ];

  return tokens.map(([name, value]) => `${name}:${formatOklch(value)}`).join(";");
}

/**
 * The stylesheet for one accent, ready to be inlined in the SSR'd HTML.
 *
 * Two things about the selectors are load-bearing.
 *
 * **Specificity.** globals.css declares these tokens at `:root` and `.dark`,
 * both (0,1,0). `:root:not(.dark)` and `:root.dark` are both (0,2,0), so they
 * win outright and it does not matter whether this sheet is parsed before or
 * after the bundled CSS — which is not something worth relying on, given React
 * may hoist a `<style>` into `<head>` and Next.js decides where the bundle link
 * goes. The naive `:root { … }` would tie with globals' `:root` and be settled
 * by document order, and worse, would *beat* `.dark` and paint the light-theme
 * accent onto a dark page.
 *
 * **Mutual exclusion.** The two rules are written so exactly one can ever match,
 * which is what lets both live in the page at once and lets the theme toggle
 * work with no server round trip: next-themes adds or removes `.dark` on
 * `<html>` and the accent follows in the same frame.
 *
 * Returns "" for GRAPHITE — see the note on the GRAPHITE definition.
 */
export function accentStyleSheet(value: unknown): string {
  const name = resolveAccent(value);

  if (name === DEFAULT_ACCENT) {
    return "";
  }

  const definition = ACCENTS[name];

  return (
    `:root:not(.dark){${declarations(definition.light)}}` +
    `:root.dark{${declarations(definition.dark)}}`
  );
}
