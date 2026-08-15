/**
 * What the pictures under a channel's narration look like, in the words the
 * operator picks between.
 *
 * A plain client-safe module for the same reason `youtube-categories.ts` and
 * `youtube-audience.ts` are: the picker that edits this is a client
 * component and these are strings it renders on its first frame, while
 * `footage.service.ts` — which turns the stored value into actual searches —
 * is `server-only`.
 *
 * The values mirror the `FootageStyle` enum in prisma/schema.prisma exactly,
 * and `FOOTAGE_STYLES` is typed against it below so adding a value to the
 * enum without describing it here fails the build rather than rendering a
 * picker that silently omits an option.
 */

import type { FootageStyle } from "@/generated/prisma/enums";

/** Mirrors the column default in prisma/schema.prisma and `BrandService`'s
 *  own FALLBACK. All three have to agree, for the same reason the publishing
 *  pair's three copies do: a channel with no brand row, a brand row created
 *  before this column existed, and a freshly branded channel must all collect
 *  the same footage with nothing asked of the operator. */
export const DEFAULT_FOOTAGE_STYLE: FootageStyle = "LIVE_ACTION";

export interface FootageStyleOption {
  value: FootageStyle;
  label: string;
  /** What actually changes, in one line — which providers get searched, and
   *  what the operator should expect when the library comes up short. */
  description: string;
}

/**
 * Ordered as the picker lists them, live action first because it is the
 * default and what every existing channel already does.
 *
 * The descriptions name the trade-off rather than selling the feature.
 * Cartoon footage comes from a genuinely smaller library — Pixabay's
 * animation filter over a few thousand relevant clips — and a children's
 * video that cannot find a cartoon comes back with fewer clips rather than
 * with live action in it. An operator who is not told that reads a short
 * video as a bug.
 */
export const FOOTAGE_STYLES: readonly FootageStyleOption[] = [
  {
    value: "LIVE_ACTION",
    label: "Live action",
    description:
      "Filmed footage from Pexels and Pixabay. The default, and what every channel used before this setting existed.",
  },
  {
    value: "CARTOON",
    label: "Cartoon",
    description:
      "Animation from Pixabay's cartoon library, with safe search on. A smaller pool than live action: a section with no cartoon match is left without footage rather than filled with live action.",
  },
];

/** Short label for a channel card, where there is room for two words. */
export function footageStyleLabel(style: FootageStyle): string {
  return FOOTAGE_STYLES.find((option) => option.value === style)?.label ?? style;
}
