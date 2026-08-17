import type { Metadata } from "next";

import { V2Cta, V2Faq } from "@/features/marketing-v2/components/v2-faq";
import { V2Features } from "@/features/marketing-v2/components/v2-features";
import { V2Hero } from "@/features/marketing-v2/components/v2-hero";
import { V2Marquee } from "@/features/marketing-v2/components/v2-marquee";
import { V2Output } from "@/features/marketing-v2/components/v2-output";
import { V2Pipeline } from "@/features/marketing-v2/components/v2-pipeline";
import { V2Pricing } from "@/features/marketing-v2/components/v2-pricing";
import { V2Shell } from "@/features/marketing-v2/components/v2-shell";
import { V2Studio } from "@/features/marketing-v2/components/v2-studio";

/**
 * A second landing page, built with React Bits, so the two can be compared
 * side by side. `/` is untouched.
 *
 * It is a different page, not a re-skin. v1 is a stack of bordered sections
 * under a full-width sticky bar: masthead, vertical timeline, bento grid,
 * focus cards, lamp, meteors. v2 floats a single pill over one continuous
 * surface and changes the *gestures*: a full-height opening frame whose
 * second line writes itself, the run's inventory as a scroll-reactive marquee,
 * the six stages as a track you swipe sideways, the three output artefacts as
 * a deck that deals itself, and the studio as a ledger rather than tiles. The
 * copy is the same because the product is the same; almost nothing else is.
 *
 * `noindex` on purpose, and it is not a detail. Two URLs on one domain telling
 * the same product story with the same copy is a duplicate-content problem at
 * best; on a domain currently under a Google Safe Browsing review, an
 * unannounced second front page is a signal worth not sending. It is also
 * absent from `sitemap.ts`, which lists the four routes a signed-out visitor
 * is meant to be led to.
 *
 * The approval-gate claim — "it stops twice, for you" — is made in the hero,
 * in the pipeline section's heading and both of its gated stages, in the
 * features grid and its inventory, and in the first FAQ answer. v1's page
 * comment asks that at least the hero and the pipeline keep it; both do.
 */
export const metadata: Metadata = {
  title: "Framecast v2",
  description:
    "An alternative landing page for Framecast, built with React Bits, for comparison against the current one.",
  robots: { index: false, follow: false },
};

export default function V2Page() {
  return (
    <V2Shell>
      <V2Hero />
      <V2Marquee />
      <V2Pipeline />
      <V2Output />
      <V2Features />
      <V2Studio />
      <V2Pricing />
      <V2Faq />
      <V2Cta />
    </V2Shell>
  );
}
