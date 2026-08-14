import { pageMetadata } from "@/components/seo/page-metadata";
import {
  LegalDocument,
  LegalSection,
} from "@/features/marketing/components/legal-document";
import { MarketingShell } from "@/features/marketing/components/marketing-shell";
import { Fragment } from "react";
import { OPERATOR_EMAILS } from "@/config/site";

// Google's OAuth review fetches this URL specifically, so it has to be
// self-canonical rather than inheriting the layout's `/`.
export const metadata = pageMetadata({
  title: "Privacy policy",
  description:
    "What data Framecast collects, how Google and YouTube data is used, and how to revoke access.",
  path: "/privacy",
});

/**
 * Google's OAuth review requires this page to state, specifically, which Google
 * user data is requested, why, and how it is retained — vague boilerplate is a
 * common cause of rejection. Keep it concrete and keep it true.
 */
export default function PrivacyPage() {
  return (
    <MarketingShell width="wide">
      <LegalDocument
        title="Privacy policy"
        updated="Last updated 13 August 2026"
        contents={[
        { id: "what-framecast-is", label: "What Framecast is" },
        { id: "data-collected-when-you-sign-in", label: "Data collected when you sign in" },
        { id: "youtube-data-when-you-connect-a-channel", label: "YouTube data, when you connect a channel" },
        { id: "where-data-is-stored", label: "Where data is stored" },
        { id: "third-party-services", label: "Third-party services" },
        { id: "retention-and-deletion", label: "Retention and deletion" },
        { id: "contact", label: "Contact" },
        ]}
      >

        <LegalSection id="what-framecast-is" heading="What Framecast is">
          <p className="text-muted-foreground text-sm text-pretty">
            Framecast is a video production tool operated by its owner. Anyone may
            register for an account, and every new account is held for approval
            before it can be used: until the operator approves it, a registered
            account can sign in and see that it is waiting, and nothing else. It is
            not affiliated with, endorsed by, or operated by Google or YouTube.
          </p>
        </LegalSection>

        <LegalSection id="data-collected-when-you-sign-in" heading="Data collected when you sign in">
          <p className="text-muted-foreground text-sm text-pretty">
            Signing in with Google gives Framecast your email address, name and
            profile picture. These are used only to identify your account and to
            display who is signed in. Signing in with an email address and password
            stores that address and a hashed password — the password itself is never
            stored.
          </p>
        </LegalSection>

        <LegalSection id="youtube-data-when-you-connect-a-channel" heading="YouTube data, when you connect a channel">
          <p className="text-muted-foreground text-sm text-pretty">
            Connecting a YouTube channel is a separate, optional step with its own
            consent screen. Framecast requests two permissions:
          </p>
          <ul className="text-muted-foreground space-y-2 text-sm">
            <li className="text-pretty">
              <span className="text-foreground font-medium">Read your channel</span>{" "}
              — channel name, thumbnail, subscriber and view counts, and the list of
              videos published through Framecast. Used to display your channel in
              the studio.
            </li>
            <li className="text-pretty">
              <span className="text-foreground font-medium">Upload videos</span> —
              used only to publish a video you have explicitly approved. Framecast
              never uploads, edits, deletes or comments on anything without that
              approval.
            </li>
            <li className="text-pretty">
              <span className="text-foreground font-medium">
                Read your channel&apos;s analytics
              </span>{" "}
              — views, watch time, average view duration, impressions,
              click-through rate and subscribers gained. Used to show how your
              videos performed inside the studio, so you can see which topics and
              thumbnails worked.
            </li>
            <li className="text-pretty">
              <span className="text-foreground font-medium">
                Read your estimated revenue
              </span>{" "}
              — the earnings figure YouTube reports for your own videos. Displayed
              back to you alongside what each video cost to produce. It is never
              shared, aggregated with anyone else&apos;s data, or used for any
              other purpose.
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
        </LegalSection>

        <LegalSection id="where-data-is-stored" heading="Where data is stored">
          <p className="text-muted-foreground text-sm text-pretty">
            The application and its private PostgreSQL database both run on a
            single dedicated server rented from OVH, in London. The database
            accepts no connections from the internet: it is reachable only by the
            application running beside it on that same machine, over the host&apos;s
            own internal network. Uploaded and generated files — narration audio,
            video clips, thumbnails and finished videos — are stored on that
            server&apos;s disk, not with a third-party storage provider.
          </p>
          <p className="text-muted-foreground text-sm text-pretty">
            Access tokens for connected accounts, and any third-party API keys you
            enter, are encrypted at rest with AES-256-GCM before being written to
            the database.
          </p>
          <p className="text-muted-foreground text-sm text-pretty">
            The database is backed up nightly to Cloudflare R2 object storage, so
            that a failure of the server itself is recoverable. Those backups
            contain the same data as the database, including the encrypted values
            described above, and are deleted after 30 days.
          </p>
        </LegalSection>

        <LegalSection id="third-party-services" heading="Third-party services">
          <p className="text-muted-foreground text-sm text-pretty">
            Producing a video sends the topic and script text you create to the AI
            providers configured by the operator, in order to generate the script,
            narration audio and thumbnail image. It does not send your Google
            account details or your YouTube channel data to those providers.
          </p>
        </LegalSection>

        <LegalSection id="retention-and-deletion" heading="Retention and deletion">
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
        </LegalSection>

        <LegalSection id="contact" heading="Contact">
          <p className="text-muted-foreground text-sm text-pretty">
            Questions about this policy, or requests to delete data, can be sent
            to either address below. Both reach the operator directly.{" "}
            {OPERATOR_EMAILS.map((address, index) => (
              <Fragment key={address}>
                {index > 0 ? " or " : ""}
                <a
                  href={`mailto:${address}`}
                  className="text-foreground underline underline-offset-4"
                >
                  {address}
                </a>
              </Fragment>
            ))}
            .
          </p>
        </LegalSection>
      </LegalDocument>
    </MarketingShell>
  );
}
