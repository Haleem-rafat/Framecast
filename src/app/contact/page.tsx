import Link from "next/link";
import { KeyRound, LifeBuoy, Mail, ShieldCheck, Trash2 } from "lucide-react";

import { pageMetadata } from "@/components/seo/page-metadata";
import {
  LegalDocument,
  LegalSection,
} from "@/features/marketing/components/legal-document";
import { MarketingShell } from "@/features/marketing/components/marketing-shell";

/** The address already published in the privacy policy. Kept in one place. */
// Single source of truth — see src/config/site.ts. Hardcoding it here
// meant two places to miss when the operator added a second address.
import { OPERATOR_EMAIL } from "@/config/site";

// This is the page a Safe Browsing reviewer is most likely to look for, so it
// must not canonicalise away to the homepage.
export const metadata = pageMetadata({
  title: "Contact",
  description:
    "How to reach the operator of Framecast — for account requests, data deletion, security reports and anything else.",
  path: "/contact",
});

const ROUTES = [
  {
    icon: LifeBuoy,
    title: "An account, or a question about one",
    subject: "Framecast account",
    body: "Framecast is a private studio tool, so accounts are reviewed by an operator before they can be used. If you have created one and are waiting, or something is not working, this is the address.",
  },
  {
    icon: Trash2,
    title: "Deleting your data",
    subject: "Framecast data deletion request",
    body: "Ask here to have an account and everything associated with it deleted. You can disconnect a YouTube channel yourself at any time from the studio, which removes the stored tokens immediately.",
  },
  {
    icon: ShieldCheck,
    title: "Security and privacy",
    subject: "Framecast security report",
    body: "Report a vulnerability, or ask anything about how data is handled that the privacy policy does not already answer.",
  },
];

/**
 * Google's own guidance on the "deceptive site" flag asks for a way to reach a
 * real person, so this page exists and is linked from the footer of every
 * public page.
 *
 * There is deliberately no contact form. Nothing in this codebase can receive
 * one — there is no inbox, no ticket store and no transactional mail — and a
 * form that swallows a message and shows a cheerful "thanks!" is a lie told
 * with a submit button, on a domain that can least afford one. Every route
 * below is a `mailto:` to an address that is monitored, pre-filled with a
 * subject so it lands somewhere useful.
 *
 * Wrapped in `MarketingShell` like `/terms` and `/privacy` are. This page was
 * the one public route rendering `LegalDocument` bare, and the shell is not
 * decoration: it is the only thing that supplies `<main>`, the site `<header>`
 * and the footer. Without it this page had no main landmark at all — so "skip
 * to content" had nothing to skip to — no way back to the rest of the site, and
 * none of the `.marketing` palette its siblings are designed against. It is
 * also, per the note above, the page a Safe Browsing reviewer is most likely to
 * open, which makes "looks like it belongs to the same site" load-bearing.
 */
export default function ContactPage() {
  return (
    <MarketingShell width="wide">
      <LegalDocument
        title="Contact"
        updated="One address, monitored by the operator"
        intro="Framecast is run by one person, not a support department. Everything below goes to the same inbox — the subject line is only there to help sort it."
        contents={[
          { id: "reach", label: "How to reach us" },
          { id: "no-form", label: "Why there is no form" },
          { id: "elsewhere", label: "What is answered elsewhere" },
        ]}
      >
        <LegalSection id="reach" heading="How to reach us">
          <div className="not-prose grid gap-4 sm:grid-cols-2">
            {ROUTES.map((route) => (
              <a
                key={route.title}
                href={`mailto:${OPERATOR_EMAIL}?subject=${encodeURIComponent(route.subject)}`}
                className="bg-card hover:border-brand-violet/50 group block rounded-xl border p-5 transition-colors"
              >
                <route.icon className="text-brand-violet size-5" />
                <h3 className="mt-3 text-sm font-medium">{route.title}</h3>
                <p className="text-muted-foreground mt-1.5 text-sm text-pretty">
                  {route.body}
                </p>
                <p className="text-brand-blue-ink mt-3 inline-flex items-center gap-1.5 text-sm group-hover:underline">
                  <Mail className="size-3.5" />
                  {OPERATOR_EMAIL}
                </p>
              </a>
            ))}

            <div className="bg-muted/40 rounded-xl border border-dashed p-5">
              <KeyRound className="text-muted-foreground size-5" />
              <h3 className="mt-3 text-sm font-medium">Anything about billing</h3>
              <p className="text-muted-foreground mt-1.5 text-sm text-pretty">
                There is nothing to bill. Framecast has no payment system — no
                checkout, no subscription, no card on file — so there is no
                invoice to query and no charge to dispute. The AI providers you
                supply keys for bill you directly, and only they can answer for
                that.
              </p>
            </div>
          </div>
        </LegalSection>

        <LegalSection id="no-form" heading="Why there is no form">
          <p>
            Nothing in Framecast can receive a contact form: there is no inbox
            behind the app, no ticket store and no transactional mail. A form that
            accepted a message and then discarded it would look like it worked and
            would not, so there isn&apos;t one. The links above open your own mail
            client, addressed to a real account that is read.
          </p>
        </LegalSection>

        <LegalSection id="elsewhere" heading="What is answered elsewhere">
          <p>
            Which Google and YouTube permissions are requested, what is done with
            them, where data is stored and how long it is kept are all set out in
            the{" "}
            <Link
              href="/privacy"
              className="text-foreground underline underline-offset-4"
            >
              privacy policy
            </Link>
            . What you may use Framecast for, who owns the videos it makes and who
            pays the third-party costs are in the{" "}
            <Link
              href="/terms"
              className="text-foreground underline underline-offset-4"
            >
              terms of service
            </Link>
            .
          </p>
          <p>
            You can also revoke Framecast&apos;s access to your Google account
            yourself, without asking anyone, at{" "}
            <a
              href="https://myaccount.google.com/permissions"
              className="text-foreground underline underline-offset-4"
              target="_blank"
              rel="noreferrer noopener"
            >
              myaccount.google.com/permissions
            </a>
            .
          </p>
        </LegalSection>
      </LegalDocument>
    </MarketingShell>
  );
}
