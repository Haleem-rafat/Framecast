import { pageMetadata } from "@/components/seo/page-metadata";
import { LandingPricing } from "@/features/marketing/components/landing-pricing";
import { MarketingShell } from "@/features/marketing/components/marketing-shell";

export const metadata = pageMetadata({
  title: "Pricing",
  description:
    "Framecast Studio plans: a free trial, then Creator, Pro and Agency, with the AI included.",
  path: "/pricing",
});

/** The landing page's pricing section on an address of its own. */
export default function PricingPage() {
  return (
    <MarketingShell width="wide">
      <LandingPricing />
    </MarketingShell>
  );
}
