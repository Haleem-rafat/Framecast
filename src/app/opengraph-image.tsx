import { ImageResponse } from "next/og";

import { LOGO_FRAME_PATH, LOGO_PLAY_PATH } from "@/components/brand/logo-mark";
import { SITE_NAME } from "@/config/site";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt =
  "Framecast — topic in, finished YouTube video out, with a human review before anything publishes.";

/**
 * The card a shared link renders as.
 *
 * No custom font is loaded: the CSP blocks external font hosts, and a webfont
 * that silently fails to resolve would leave Satori falling back mid-layout —
 * worse than committing to the system stack from the start. Satori also has no
 * cascade, so every colour here is explicit rather than inherited.
 *
 * The copy states what the product does and what it refuses to do without a
 * human, since that gate is the actual product decision worth advertising.
 */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#0a0a0a",
          padding: 72,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none">
            <path
              d={LOGO_FRAME_PATH}
              stroke="#fafafa"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d={LOGO_PLAY_PATH} fill="#fafafa" />
          </svg>
          <div style={{ color: "#fafafa", fontSize: 40, letterSpacing: -0.5 }}>
            {SITE_NAME}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div
            style={{
              color: "#fafafa",
              fontSize: 72,
              lineHeight: 1.1,
              letterSpacing: -2,
              maxWidth: 900,
            }}
          >
            A topic goes in. A finished video comes out.
          </div>
          <div style={{ color: "#a1a1a1", fontSize: 30, maxWidth: 820, lineHeight: 1.4 }}>
            Script, narration, footage and captions — assembled automatically,
            then held for your review before anything reaches YouTube.
          </div>
        </div>
      </div>
    ),
    size,
  );
}
