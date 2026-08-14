import type { Metadata } from "next";
import Link from "next/link";

import {
  LegalDocument,
  LegalSection,
} from "@/features/marketing/components/legal-document";
import { MarketingShell } from "@/features/marketing/components/marketing-shell";

export const metadata: Metadata = {
  title: "Terms of service",
  description:
    "The terms under which Framecast, a private video production tool, may be used.",
};

export default function TermsPage() {
  return (
    <MarketingShell width="wide">
      <LegalDocument
        title="Terms of service"
        updated="Last updated 9 August 2026"
        contents={[
        { id: "who-may-use-framecast", label: "Who may use Framecast" },
        { id: "your-content-and-your-channel", label: "Your content and your channel" },
        { id: "ai-generated-material", label: "AI-generated material" },
        { id: "third-party-costs", label: "Third-party costs" },
        { id: "availability-and-warranty", label: "Availability and warranty" },
        { id: "changes", label: "Changes" },
        ]}
      >

        <LegalSection id="who-may-use-framecast" heading="Who may use Framecast">
          <p className="text-muted-foreground text-sm text-pretty">
            Framecast is a private tool. Access is granted by the operator to
            specific, named accounts. Attempting to access it without
            authorisation is not permitted. There is no public sign-up, and no
            account is created automatically.
          </p>
        </LegalSection>

        <LegalSection id="your-content-and-your-channel" heading="Your content and your channel">
          <p className="text-muted-foreground text-sm text-pretty">
            You keep ownership of the topics, scripts and videos you create. If you
            connect a YouTube channel, you remain responsible for everything
            published to it and for complying with{" "}
            <a
              href="https://www.youtube.com/t/terms"
              className="text-foreground underline underline-offset-4"
              target="_blank"
              rel="noreferrer noopener"
            >
              YouTube&apos;s Terms of Service
            </a>{" "}
            and its monetization and content policies. Framecast publishes only
            what you have explicitly approved.
          </p>
        </LegalSection>

        <LegalSection id="ai-generated-material" heading="AI-generated material">
          <p className="text-muted-foreground text-sm text-pretty">
            Scripts, narration and images are produced by third-party AI models.
            Their output can be wrong, biased or misleading, and it is not checked
            for accuracy by Framecast. Reviewing material before publishing is your
            responsibility — that is why approval steps exist and cannot be skipped
            for the final cut.
          </p>
        </LegalSection>

        <LegalSection id="third-party-costs" heading="Third-party costs">
          <p className="text-muted-foreground text-sm text-pretty">
            Generating scripts, narration and images consumes paid third-party API
            credits billed to whoever supplied the API keys. Framecast records the
            cost of each generation, but it does not cap spending and is not
            responsible for charges incurred.
          </p>
        </LegalSection>

        <LegalSection id="availability-and-warranty" heading="Availability and warranty">
          <p className="text-muted-foreground text-sm text-pretty">
            Framecast is under active development and is provided as-is, without
            warranty of any kind. It may be unavailable, may lose data, and may
            change or be withdrawn at any time. To the extent permitted by law, the
            operator is not liable for any loss arising from its use, including
            lost revenue or removed videos.
          </p>
        </LegalSection>

        <LegalSection id="changes" heading="Changes">
          <p className="text-muted-foreground text-sm text-pretty">
            These terms may change. The date at the top of this page reflects the
            most recent revision. See also the{" "}
            <Link href="/privacy" className="text-foreground underline underline-offset-4">
              privacy policy
            </Link>
            .
          </p>
        </LegalSection>
      </LegalDocument>
    </MarketingShell>
  );
}
