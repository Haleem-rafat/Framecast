"use client";

import { brandFontStack } from "@/lib/brand-fonts";

/**
 * The thing the colour and the font actually make, at the proportions it is
 * actually made at.
 *
 * A hex field tells an operator what they typed. It does not tell them that
 * `#FFF9C4` is unreadable, or that the mono face turns a nine-word headline
 * into something two thirds the size. This does, and it is the only part of
 * this screen whose value is that it is looked at rather than read.
 *
 * It reproduces `buildThumbnailArgs`'s headline rather than inventing a
 * presentation of its own: text in `primaryColour`, over a black box at 60%
 * opacity, bottom-anchored in a 16:9 frame. Those are not decorative choices
 * there — the box exists because the background is an AI-generated image that
 * nothing can predict, and black-at-60% reads under any picture — so a preview
 * without it would flatter a colour the real thumbnail is about to put on a
 * dark panel.
 *
 * Two honest limits, both stated on screen. The background here is a flat
 * gradient standing in for a generated image nobody has generated yet. And the
 * face is the browser's nearest match unless the operator happens to be on a
 * machine with DejaVu installed — the render worker has the real ones, which
 * is the whole reason the picker is a list (see `brand-fonts.ts`).
 *
 * Nothing here animates, so there is nothing for `prefers-reduced-motion` to
 * suppress; the colour follows the field as it is dragged because the value
 * changed, not because anything is transitioning.
 */
export function HeadlinePreview({
  colour,
  font,
}: {
  colour: string;
  font: string;
}) {
  // The same allowlist `resolveHeadlineColour` applies before this value
  // reaches FFmpeg, applied here for the same reason: while a hex is
  // half-typed the field is invalid, and the preview should show what would be
  // drawn rather than nothing at all.
  const drawn = /^#[0-9a-fA-F]{6}$/.test(colour) ? colour : "#FFFFFF";

  return (
    <div className="space-y-2">
      <p className="text-sm leading-none font-medium">Thumbnail headline</p>

      <div
        // 16:9, because that is the frame the headline is fitted to and a
        // square preview would misrepresent how much room a long one has.
        className="relative aspect-video w-full max-w-sm overflow-hidden rounded-lg border bg-gradient-to-br from-zinc-700 to-zinc-900"
        // Decorative: everything it conveys is in the fields above it and in
        // the caption below, and reading a fake headline out is noise.
        aria-hidden="true"
      >
        <div className="absolute inset-x-0 bottom-[7.8%] flex justify-center px-[3%]">
          <span
            // 16px here is roughly a 53px `fontsize` scaled to this frame,
            // which is mid-range for `fitHeadline` (28–72) — so a headline
            // that looks cramped here is a headline that will be.
            className="max-w-full truncate rounded-[2px] bg-black/60 px-2 py-0.5 text-base leading-tight"
            style={{ color: drawn, fontFamily: brandFontStack(font) }}
          >
            Your headline goes here
          </span>
        </div>
      </div>

      <p className="text-muted-foreground text-xs">
        The headline as FFmpeg draws it — your colour on a black box at 60%,
        over the generated image. The background here is a stand-in, and the
        font is your browser&apos;s nearest match to the one the render worker
        has.
      </p>
    </div>
  );
}
