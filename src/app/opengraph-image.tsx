import { ImageResponse } from "next/og";

import { LOGO_FRAME_PATH, LOGO_PLAY_PATH } from "@/components/brand/logo-mark";
import {
  OG_IMAGE_ALT,
  OG_IMAGE_CONTENT_TYPE,
  OG_IMAGE_SIZE,
} from "@/components/seo/og-image";
import { SITE_NAME, SITE_URL } from "@/config/site";

// Next.js reads these three exports off this module to build the
// `og:image:width`, `og:image:height`, `og:image:type` and `og:image:alt`
// tags. They live in `og-image.ts` so `page-metadata.ts` can state the same
// numbers without a second copy of them.
export const size = OG_IMAGE_SIZE;
export const contentType = OG_IMAGE_CONTENT_TYPE;
export const alt = OG_IMAGE_ALT;

/** The origin without its scheme, for the wordmark in the top-right corner. */
const DISPLAY_HOST = SITE_URL.replace(/^https?:\/\//, "");

/**
 * The stages a video moves through, in the order the pipeline runs them. Each
 * one is a real step in this codebase — the script generator, the ElevenLabs
 * call, the per-line footage match, the FFmpeg render, the YouTube upload —
 * not a marketing abstraction of them.
 */
const PIPELINE = ["Script", "Narration", "Footage", "Render", "YouTube"];

/**
 * The card a shared link renders as.
 *
 * ── Satori constraints ──────────────────────────────────────────────────────
 * This is rendered by Satori, not a browser, which changes three things:
 *
 *   - There is no cascade, so every colour is stated on the element that uses
 *     it. That is also why the logo is redrawn from the exported path geometry
 *     rather than by rendering `<LogoMark>`: that component paints with
 *     `currentColor`, which has nothing to inherit from here.
 *   - Any element with more than one child needs an explicit `display: flex`;
 *     Satori has no block layout to fall back on.
 *   - No custom font is loaded. The CSP blocks external font hosts, and a
 *     webfont that silently fails to resolve would leave Satori falling back
 *     mid-layout — worse than committing to the bundled stack from the start.
 *     Every glyph used here, the arrow included, is covered by it.
 *
 * ── The copy ────────────────────────────────────────────────────────────────
 * The headline states the outcome, the strip states the mechanism, and the
 * last line states the constraint. The constraint is the part worth the space:
 * on a domain under review, "nothing publishes without a human" is both the
 * true description of the approval gates and the single most useful thing a
 * reviewer or a reader can learn from a preview card. Nothing here claims a
 * price, a rating, a user count or an integration the code does not have.
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
          backgroundColor: "#0a0a0a",
          padding: 72,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <svg width="52" height="52" viewBox="0 0 24 24" fill="none">
              <path
                d={LOGO_FRAME_PATH}
                stroke="#fafafa"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path d={LOGO_PLAY_PATH} fill="#fafafa" />
            </svg>
            <div style={{ color: "#fafafa", fontSize: 38, letterSpacing: -0.5 }}>
              {SITE_NAME}
            </div>
          </div>
          <div style={{ color: "#737373", fontSize: 24 }}>{DISPLAY_HOST}</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              color: "#fafafa",
              fontSize: 76,
              lineHeight: 1.08,
              letterSpacing: -2.5,
            }}
          >
            <div>A topic goes in.</div>
            <div>A finished video comes out.</div>
          </div>

          {/* The pipeline, as a row of stages. Rendered as separate elements
              rather than one joined string so the arrows can be dimmed against
              the stage names instead of competing with them. */}
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            {PIPELINE.map((stage, index) => (
              <div
                key={stage}
                style={{ display: "flex", alignItems: "center", gap: 16 }}
              >
                {index > 0 ? (
                  <div style={{ color: "#525252", fontSize: 26 }}>→</div>
                ) : null}
                <div
                  style={{
                    display: "flex",
                    color: "#d4d4d4",
                    fontSize: 26,
                    letterSpacing: 0.2,
                    border: "1px solid #2e2e2e",
                    borderRadius: 999,
                    padding: "10px 22px",
                  }}
                >
                  {stage}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            color: "#a1a1a1",
            fontSize: 28,
            lineHeight: 1.4,
            maxWidth: 900,
          }}
        >
          Nothing runs until you approve the script, and nothing publishes until
          you approve the cut.
        </div>
      </div>
    ),
    size,
  );
}
