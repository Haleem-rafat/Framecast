import type { Metadata } from "next";
import Link from "next/link";

import {
  MarketingHeading,
  MarketingShell,
} from "@/features/marketing/components/marketing-shell";

export const metadata: Metadata = {
  title: "Terms of service",
  description:
    "The terms under which Framecast, a private video production tool, may be used.",
};

export default function TermsPage() {
  return (
    <MarketingShell>
      <article className="space-y-8">
        <MarketingHeading
          title="Terms of service"
          subtitle="Last updated 9 August 2026"
        />

        <section className="space-y-3">
          <h2 className="font-medium">Who may use Framecast</h2>
          <p className="text-muted-foreground text-sm text-pretty">
            Framecast is a private tool. Access is granted by the operator to
            specific, named accounts. Attempting to access it without
            authorisation is not permitted. There is no public sign-up, and no
            account is created automatically.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-medium">Your content and your channel</h2>
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
        </section>

        <section className="space-y-3">
          <h2 className="font-medium">AI-generated material</h2>
          <p className="text-muted-foreground text-sm text-pretty">
            Scripts, narration and images are produced by third-party AI models.
            Their output can be wrong, biased or misleading, and it is not checked
            for accuracy by Framecast. Reviewing material before publishing is your
            responsibility — that is why approval steps exist and cannot be skipped
            for the final cut.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-medium">Third-party costs</h2>
          <p className="text-muted-foreground text-sm text-pretty">
            Generating scripts, narration and images consumes paid third-party API
            credits billed to whoever supplied the API keys. Framecast records the
            cost of each generation, but it does not cap spending and is not
            responsible for charges incurred.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-medium">Availability and warranty</h2>
          <p className="text-muted-foreground text-sm text-pretty">
            Framecast is under active development and is provided as-is, without
            warranty of any kind. It may be unavailable, may lose data, and may
            change or be withdrawn at any time. To the extent permitted by law, the
            operator is not liable for any loss arising from its use, including
            lost revenue or removed videos.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-medium">Changes</h2>
          <p className="text-muted-foreground text-sm text-pretty">
            These terms may change. The date at the top of this page reflects the
            most recent revision. See also the{" "}
            <Link href="/privacy" className="text-foreground underline underline-offset-4">
              privacy policy
            </Link>
            .
          </p>
        </section>
      </article>
    </MarketingShell>
  );
}
