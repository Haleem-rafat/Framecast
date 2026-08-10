import type { SVGProps } from "react";

/**
 * Path geometry only, on a 24x24 grid (matching lucide-react's viewBox, so
 * the mark drops into the same `size-*` classes as the icons it sits beside).
 * Exported separately so the generated icon/opengraph-image routes below can
 * redraw the same shape with an explicit fill instead of `currentColor` —
 * `ImageResponse` renders through Satori, not the DOM, and cannot be relied
 * on to resolve `currentColor` the way a browser does.
 *
 * The mark is four viewfinder corners (a "frame") around a play triangle
 * ("cast" — broadcasting what the frame holds). Pure line and triangle, no
 * gradients or fine detail, so it stays legible from a 16px favicon up to a
 * 512px app icon.
 */
export const LOGO_FRAME_PATH = "M4 8V4H8M16 4H20V8M20 16V20H16M8 20H4V16";
export const LOGO_PLAY_PATH = "M10 8.5V15.5L16 12L10 8.5Z";

/**
 * Framecast's mark component for use inside the app (sidebar, sign-in page,
 * marketing header). Greyscale by design: colored via `currentColor`, so set
 * it with a parent `text-*` class exactly like the lucide icons around it.
 */
export function LogoMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
      <path
        d={LOGO_FRAME_PATH}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d={LOGO_PLAY_PATH} fill="currentColor" />
    </svg>
  );
}
