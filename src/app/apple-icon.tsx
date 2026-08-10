import { ImageResponse } from "next/og";

import { LOGO_FRAME_PATH, LOGO_PLAY_PATH } from "@/components/brand/logo-mark";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** The home-screen icon. Same mark as `icon.tsx`, drawn larger — iOS applies
 *  its own rounding, so this stays a full-bleed square. */
export default function AppleIcon() {
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
        }}
      >
        <svg width="110" height="110" viewBox="0 0 24 24" fill="none">
          <path
            d={LOGO_FRAME_PATH}
            stroke="#fafafa"
            strokeWidth="2"
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
