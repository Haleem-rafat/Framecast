import type { Metadata } from "next";

import { V2Cta, V2Faq } from "@/features/marketing-v2/components/v2-faq";
import { V2Features } from "@/features/marketing-v2/components/v2-features";
import { V2Marquee } from "@/features/marketing-v2/components/v2-marquee";
import { V2Pipeline } from "@/features/marketing-v2/components/v2-pipeline";
import { V2Pricing } from "@/features/marketing-v2/components/v2-pricing";
import { V2Studio } from "@/features/marketing-v2/components/v2-studio";
import { V3Expand } from "@/features/marketing-v3/components/v3-expand";
import { V3Hero } from "@/features/marketing-v3/components/v3-hero";
import { V3Shell } from "@/features/marketing-v3/components/v3-shell";

/**
 * A third landing page, for comparison against v1 at `/` and v2 at `/v2`.
 * Neither of those is touched by anything here.
 *
 * v3 is deliberately a mix rather than a fourth ground-up design. The bands
 * that /v2 already got right are imported from it unchanged — the stage track
 * with its two electric gates, the scroll-reactive inventory marquee, the
 * feature grid, the studio ledger, pricing and the FAQ — and three things are
 * new:
 *
 *   - a scroll-contracting navbar, open across the page at rest and pulled
 *     into a floating pill once you move;
 *   - a hero whose headline assembles itself out of drifting particles over a
 *     raymarched wave field;
 *   - the 16:9 master opening from a card to full bleed as it passes.
 *
 * That is the point of the route: it isolates three effects against a page
 * whose other seven bands are known-good, so what is being judged is the
 * effects rather than a whole second layout.
 *
 * `noindex`, and it is not a detail. Three URLs on one domain telling the same
 * product story with the same copy is a duplicate-content problem at best; on
 * a domain currently under a Google Safe Browsing review, an unannounced third
 * front page is a signal worth not sending. It is absent from `sitemap.ts` for
 * the same reason.
 *
 * The approval-gate claim — "it stops twice, for you" — is made in the hero,
 * in the stage track's heading and both of its gated cards, in the features
 * grid, in the marquee's two amber entries and in the first FAQ answer. v1's
 * page comment asks that at least the hero and the pipeline keep it; both do.
 */
export const metadata: Metadata = {
  title: "Framecast v3",
  description:
    "A third landing page for Framecast, mixing the v2 bands with three more React Bits effects, for comparison.",
  robots: { index: false, follow: false },
};

export default function V3Page() {
  return (
    <V3Shell>
      <V3Hero />
      <V2Marquee />
      <V2Pipeline />
      <V3Expand />
      <V2Features />
      <V2Studio />
      <V2Pricing />
      <V2Faq />
      <V2Cta />
    </V3Shell>
  );
}
