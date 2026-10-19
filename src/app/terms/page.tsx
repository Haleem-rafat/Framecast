import Link from "next/link";

import { pageMetadata } from "@/components/seo/page-metadata";
import {
  LegalDocument,
  LegalSection,
} from "@/features/marketing/components/legal-document";
import { MarketingShell } from "@/features/marketing/components/marketing-shell";

export const metadata = pageMetadata({
  title: "Terms of service",
  description:
    "The terms under which Framecast, a private video production tool, may be used.",
  path: "/terms",
});

export default function TermsPage() {
  return (
    <MarketingShell width="wide">
      <LegalDocument
        title="Terms of service"
        updated="Last updated 19 October 2026"
        contents={[
        { id: "who-may-use-framecast", label: "Who may use Framecast" },
        { id: "your-content-and-your-channel", label: "Your content and your channel" },
        { id: "ai-generated-material", label: "AI-generated material" },
        { id: "plans-payments-and-refunds", label: "Plans, payments and refunds" },
        { id: "third-party-costs", label: "Third-party costs" },
        { id: "availability-and-warranty", label: "Availability and warranty" },
        { id: "changes", label: "Changes" },
        ]}
      >

        <LegalSection id="who-may-use-framecast" heading="Who may use Framecast">
          <p className="text-muted-foreground text-sm text-pretty">
            Anyone may register for a Framecast Studio account, and a new account
            can be used straight away on the free trial. We may suspend or close
            an account that breaks these terms or misuses the service.
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

        <LegalSection id="plans-payments-and-refunds" heading="Plans, payments and refunds">
          <p className="text-muted-foreground text-sm text-pretty">
            Paid plans are monthly subscriptions sold through Paddle.com, which
            acts as our reseller and merchant of record: Paddle takes the payment,
            adds any sales tax, and issues your invoices. Each plan gives a number
            of credits every billing month. Approving a script spends credits — one
            for a Short, five for a long video — and credits left at the end of a
            billing month do not carry over. If a video fails to render or you
            cancel its render, its credits are returned automatically; running it
            again spends them again. You can change plan at any time from the
            Billing page, and cancel from Manage billing; after cancelling, your
            plan and its remaining credits last until the end of the month you
            have paid for. Refund requests for a payment are handled under
            Paddle&apos;s buyer terms.
          </p>
        </LegalSection>

        <LegalSection id="third-party-costs" heading="Third-party costs">
          <p className="text-muted-foreground text-sm text-pretty">
            On a plan or the trial, the AI costs of making your videos are included.
            If you add your own API key for a provider, generation with that
            provider is billed by them to you instead. Framecast Studio records the
            cost of each generation but is not responsible for charges a provider
            makes on your own key.
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
