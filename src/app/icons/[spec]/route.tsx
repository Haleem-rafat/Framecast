import { ImageResponse } from "next/og";

import { LOGO_FRAME_PATH, LOGO_PLAY_PATH } from "@/components/brand/logo-mark";

/**
 * The app icons the web manifest points at.
 *
 * `icon.tsx` and `apple-icon.tsx` beside this already draw the same mark for
 * the browser tab and the iOS home screen. They are not reused here for one
 * reason: Next.js gives those files content-hashed URLs, and a manifest has to
 * name a *stable* path — an installed app that re-fetches its icon after a
 * deploy must not 404 and fall back to a screenshot of the page.
 *
 * So this is a plain route handler at a predictable URL, drawing the geometry
 * from the same module the other two read. Three shapes are served, and the
 * third is the one most PWAs get wrong:
 *
 *   * **192** and **512** are `purpose: "any"` — drawn edge to edge, which is
 *     what a browser shows in a tab strip or a task switcher.
 *   * **maskable-512** is `purpose: "maskable"`. Android crops an installed
 *     icon to whatever shape the launcher uses — a circle, a squircle, a
 *     rounded square — and it crops hard: only the middle ~80% is guaranteed to
 *     survive. An icon drawn edge to edge therefore comes out with its corners
 *     shaved off. This one draws the mark at 40% of the canvas inside a
 *     full-bleed background, so every launcher shape crops into flat colour.
 *
 * Satori renders this rather than a browser, so the strokes carry an explicit
 * colour instead of `currentColor` — there is no cascade here to inherit from.
 * Same reasoning as `icon.tsx`, which says so at more length.
 */

/** The mark's own colours, matching `icon.tsx` and `apple-icon.tsx`. Light on
 *  dark, because a thin dark outline on white disappears at 48px on a busy
 *  home screen. */
const BACKGROUND = "#171717";
const FOREGROUND = "#fafafa";

interface IconSpec {
  size: number;
  /** How much of the canvas the mark occupies. Below 1 leaves the safe-area
   *  margin a maskable icon needs. */
  scale: number;
}

const SPECS: Record<string, IconSpec> = {
  // Full bleed: nothing crops these.
  "192.png": { size: 192, scale: 0.72 },
  "512.png": { size: 512, scale: 0.72 },
  // The safe zone. 0.4 keeps the whole mark inside the circle Android's
  // roundest launcher crops to, with room to spare.
  "maskable-512.png": { size: 512, scale: 0.4 },
};

export function generateStaticParams(): { spec: string }[] {
  return Object.keys(SPECS).map((spec) => ({ spec }));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ spec: string }> },
): Promise<Response> {
  const { spec } = await params;
  const icon = SPECS[spec];

  if (!icon) {
    return new Response("Not found", { status: 404 });
  }

  const mark = Math.round(icon.size * icon.scale);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: BACKGROUND,
        }}
      >
        <svg
          width={mark}
          height={mark}
          viewBox="0 0 24 24"
          fill="none"
        >
          <path
            d={LOGO_FRAME_PATH}
            stroke={FOREGROUND}
            // Scaled with the mark so the outline keeps its weight relative to
            // the shape rather than thinning out at 512 and blocking up at 192.
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d={LOGO_PLAY_PATH} fill={FOREGROUND} />
        </svg>
      </div>
    ),
    { width: icon.size, height: icon.size },
  );
}
