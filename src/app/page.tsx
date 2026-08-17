import type { Metadata } from "next";

import { LandingCta } from "@/features/marketing/components/landing-cta";
import { LandingFaq } from "@/features/marketing/components/landing-faq";
import { LandingFeatures } from "@/features/marketing/components/landing-features";
import { LandingHero } from "@/features/marketing/components/landing-hero";
import { LandingOutput } from "@/features/marketing/components/landing-output";
import { LandingPipeline } from "@/features/marketing/components/landing-pipeline";
import { LandingPricing } from "@/features/marketing/components/landing-pricing";
import { LandingStudio } from "@/features/marketing/components/landing-studio";
import { MarketingShell } from "@/features/marketing/components/marketing-shell";

export const metadata: Metadata = {
  // No `title` on purpose. It used to be the string "Framecast — automated
  // video production", hand-typed, while `SITE_TAGLINE` — which the root
  // layout, the og:title and the Twitter card all use — said "automated
  // YouTube video production". Two spellings of one sentence, drifting apart.
  //
  // The root layout already sets `title.default` to SITE_TAGLINE, and a
  // template defined in a layout does not apply to that same segment's own
  // page, so omitting it here yields exactly SITE_TAGLINE with no suffix.
  // Restating it would only re-open the gap.
  description:
    "Framecast turns a topic into a finished, published video: script, narration, footage, render, upload — with a human approving the script and the final cut.",
};

export default function HomePage() {
  return (
    <MarketingShell width="wide">
      <LandingHero />
      <LandingPipeline />
      {/*
        There was a section here that put the approval gate on screen as a
        screenshot of the studio waiting on it. Removed at the owner's request.

        The *claim* is not removed with it, because it is the most
        trust-building thing this product can say and the main line between it
        and "an AI posts to my channel unsupervised". It is still made, in
        plain text, in four places: the hero's own box under the subheading,
        this pipeline section's heading and its second and sixth stages, the
        "Two places it stops and waits for you" tile in the features grid with
        both gates marked in the inventory beneath it, and the first question
        in the FAQ. Anyone editing those should keep at least the hero and the
        pipeline saying it.
      */}
      <LandingFeatures />
      <LandingOutput />
      <LandingStudio />
      <LandingPricing />
      <LandingFaq />
      <LandingCta />
    </MarketingShell>
  );
}
