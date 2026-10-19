import Link from "next/link";

import { pageMetadata } from "@/components/seo/page-metadata";
import { LegalDocument, LegalSection } from "@/features/marketing/components/legal-document";
import { MarketingShell } from "@/features/marketing/components/marketing-shell";

export const metadata = pageMetadata({
  title: "Refund and cancellation policy",
  description:
    "How cancelling a Framecast Studio plan works, when a payment is refunded, and what happens to credits.",
  path: "/refunds",
});

const text = "text-muted-foreground text-sm text-pretty";
const link = "text-foreground underline underline-offset-4";

export default function RefundsPage() {
  return (
    <MarketingShell width="wide">
      <LegalDocument
        title="Refund and cancellation policy"
        updated="Last updated 20 October 2026"
        contents={[
          { id: "who-sells", label: "Who you pay" },
          { id: "cancelling", label: "Cancelling a plan" },
          { id: "refunds", label: "Refunds" },
          { id: "credits", label: "Credits" },
          { id: "how-to-ask", label: "How to ask for a refund" },
        ]}
      >
        <LegalSection id="who-sells" heading="Who you pay">
          <p className={text}>
            Framecast Studio plans are sold by Paddle.com, our reseller and merchant of record.
            Paddle takes the payment, adds any sales tax, issues the invoice and processes every
            refund. Paddle&apos;s{" "}
            <a href="https://www.paddle.com/legal/checkout-buyer-terms" className={link} target="_blank" rel="noreferrer noopener">
              buyer terms
            </a>{" "}
            apply to your purchase alongside this policy.
          </p>
        </LegalSection>

        <LegalSection id="cancelling" heading="Cancelling a plan">
          <p className={text}>
            You can cancel at any time from Billing → Manage billing. Cancelling stops the next
            payment; your plan and its remaining credits stay until the end of the month you have
            already paid for, and nothing more is charged.
          </p>
        </LegalSection>

        <LegalSection id="refunds" heading="Refunds">
          <p className={text}>
            If you are not happy, you can ask for a full refund of any payment within 14 days of
            it. Refunds go back to the card or account you paid with, through Paddle, usually
            within 5 to 10 working days depending on your bank. After 14 days, payments are not
            refunded, but you can cancel so you are not charged again.
          </p>
        </LegalSection>

        <LegalSection id="credits" heading="Credits">
          <p className={text}>
            Credits come with your plan each month and have no cash value. If a video fails to
            render, or you cancel its render, its credits are returned automatically. Credits left
            at the end of a month do not carry over, and a refunded payment removes the credits it
            gave.
          </p>
        </LegalSection>

        <LegalSection id="how-to-ask" heading="How to ask for a refund">
          <p className={text}>
            Write to us through the{" "}
            <Link href="/contact" className={link}>
              contact page
            </Link>{" "}
            with the email address of your account and the date of the payment, or reply to the
            receipt email Paddle sent you.
          </p>
        </LegalSection>
      </LegalDocument>
    </MarketingShell>
  );
}
