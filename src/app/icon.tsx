import { ImageResponse } from "next/og";

import { LOGO_FRAME_PATH, LOGO_PLAY_PATH } from "@/components/brand/logo-mark";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

/**
 * The favicon, drawn from the same geometry as the in-app mark rather than a
 * separate asset that could drift from it.
 *
 * Satori renders this, not a browser, so the strokes carry an explicit colour
 * instead of `currentColor` — there is no cascade here to inherit from. The
 * mark is drawn light-on-dark because a browser tab strip is usually light,
 * and a dark tile holds its shape there far better than a thin dark outline on
 * white.
 */
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#171717",
          borderRadius: 7,
        }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <path
            d={LOGO_FRAME_PATH}
            stroke="#fafafa"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d={LOGO_PLAY_PATH} fill="#fafafa" />
        </svg>
      </div>
    ),
    size,
  );
}
