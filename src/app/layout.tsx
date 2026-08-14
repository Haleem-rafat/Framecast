import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { SITE_NAME, SITE_URL } from "@/config/site";
import { AppProviders } from "@/providers/app-providers";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const DESCRIPTION =
  "Framecast turns a topic into a finished YouTube video — script, narration, " +
  "footage and burnt-in captions — and holds it for your review before anything " +
  "is published.";

export const metadata: Metadata = {
  // `metadataBase` is what lets every relative OpenGraph and icon path below
  // resolve to an absolute URL. Without it Next.js warns at build time and
  // social scrapers, which do not resolve relative paths, silently show no
  // image at all.
  metadataBase: new URL(SITE_URL),
  // Google Search Console's HTML-tag method of proving domain ownership, which
  // OAuth branding verification requires before it will accept framecasts.com
  // as this app's homepage. Read from the environment rather than committed:
  // the token is specific to one Google account, and hard-coding it here would
  // silently break verification for anyone who forks or self-hosts this.
  //
  // Next.js omits the tag entirely when the variable is unset, so an
  // un-configured deployment renders exactly as it does today.
  verification: process.env.GOOGLE_SITE_VERIFICATION
    ? { google: process.env.GOOGLE_SITE_VERIFICATION }
    : undefined,
  title: {
    default: `${SITE_NAME} — automated YouTube video production`,
    template: `%s · ${SITE_NAME}`,
  },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    "automated video production",
    "YouTube automation",
    "AI video generation",
    "faceless YouTube channel",
    "text to video",
    "AI narration",
  ],
  authors: [{ name: SITE_NAME }],
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    url: SITE_URL,
    title: `${SITE_NAME} — automated YouTube video production`,
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: `${SITE_NAME} — automated YouTube video production`,
    description: DESCRIPTION,
  },
  // The dashboard is operator-only and blocked in robots.ts; this is the
  // belt-and-braces for the public pages that *should* be indexed.
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // suppressHydrationWarning is required: next-themes writes the resolved
    // theme class onto <html> before React hydrates.
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="antialiased">
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
