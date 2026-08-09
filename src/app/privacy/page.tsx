import type { Metadata } from "next";

import {
  MarketingHeading,
  MarketingShell,
} from "@/features/marketing/components/marketing-shell";

export const metadata: Metadata = {
  title: "Privacy policy",
  description:
    "What data Framecast collects, how Google and YouTube data is used, and how to revoke access.",
};

/**
 * Google's OAuth review requires this page to state, specifically, which Google
 * user data is requested, why, and how it is retained — vague boilerplate is a
 * common cause of rejection. Keep it concrete and keep it true.
 */
export default function PrivacyPage() {
  return (
    <MarketingShell>
      <article className="space-y-8">
        <MarketingHeading
          title="Privacy policy"
          subtitle="Last updated 9 August 2026"
        />

        <section className="space-y-3">
          <h2 className="font-medium">What Framecast is</h2>
          <p className="text-muted-foreground text-sm text-pretty">
            Framecast is a private video production tool operated by its owner. It
            is not a public service and has no self-registration. Accounts exist
            only for people the operator has explicitly authorised.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-medium">Data collected when you sign in</h2>
          <p className="text-muted-foreground text-sm text-pretty">
            Signing in with Google gives Framecast your email address, name and
            profile picture. These are used only to identify your account and to
            display who is signed in. Signing in with an email address and password
            stores that address and a hashed password — the password itself is never
            stored.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-medium">YouTube data, when you connect a channel</h2>
          <p className="text-muted-foreground text-sm text-pretty">
            Connecting a YouTube channel is a separate, optional step with its own
            consent screen. Framecast requests two permissions:
          </p>
          <ul className="text-muted-foreground space-y-2 text-sm">
            <li className="text-pretty">
              <span className="text-foreground font-medium">Read your channel</span>{" "}
              — channel name, thumbnail, subscriber and view counts, and statistics
              for videos published through Framecast. Used to display your channel
              in the studio and to report how published videos performed.
            </li>
            <li className="text-pretty">
              <span className="text-foreground font-medium">Upload videos</span> —
              used only to publish a video you have explicitly approved. Framecast
              never uploads, edits, deletes or comments on anything without that
              approval.
            </li>
          </ul>
          <p className="text-muted-foreground text-sm text-pretty">
            Framecast&apos;s use of information received from Google APIs adheres to
            the{" "}
            <a
              href="https://developers.google.com/terms/api-services-user-data-policy"
              className="text-foreground underline underline-offset-4"
              target="_blank"
              rel="noreferrer noopener"
            >
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements. Google user data is never
            sold, never shared with third parties, never used for advertising, and
            never used to train machine-learning models.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-medium">Where data is stored</h2>
          <p className="text-muted-foreground text-sm text-pretty">
            Data is held in a private PostgreSQL database hosted by Supabase, and
            the application runs on Vercel. Connections to the database are
            encrypted and the server certificate is verified. Access tokens for
            connected accounts, and any third-party API keys you enter, are
            encrypted at rest with AES-256-GCM before being written to the
            database.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-medium">Third-party services</h2>
          <p className="text-muted-foreground text-sm text-pretty">
            Producing a video sends the topic and script text you create to the AI
            providers configured by the operator, in order to generate the script,
            narration audio and thumbnail image. It does not send your Google
            account details or your YouTube channel data to those providers.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-medium">Retention and deletion</h2>
          <p className="text-muted-foreground text-sm text-pretty">
            Data is kept while the account exists. You can disconnect a YouTube
            channel at any time from the studio, which deletes the stored tokens.
            You can also revoke Framecast&apos;s access directly from your Google
            account at{" "}
            <a
              href="https://myaccount.google.com/permissions"
              className="text-foreground underline underline-offset-4"
              target="_blank"
              rel="noreferrer noopener"
            >
              myaccount.google.com/permissions
            </a>
            . To have an account and all associated data deleted, contact the
            operator at the address below.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="font-medium">Contact</h2>
          <p className="text-muted-foreground text-sm text-pretty">
            Questions about this policy, or requests to delete data, can be sent to{" "}
            <a
              href="mailto:eramdevteam@gmail.com"
              className="text-foreground underline underline-offset-4"
            >
              eramdevteam@gmail.com
            </a>
            .
          </p>
        </section>
      </article>
    </MarketingShell>
  );
}
