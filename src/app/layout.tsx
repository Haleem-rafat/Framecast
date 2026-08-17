import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { SiteStructuredData } from "@/components/seo/structured-data";
import {
  SITE_DESCRIPTION,
  SITE_LOCALE,
  SITE_NAME,
  SITE_TAGLINE,
  SITE_URL,
  TITLE_TEMPLATE,
} from "@/config/site";
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
    default: SITE_TAGLINE,
    template: TITLE_TEMPLATE,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  /**
   * iOS's own install layer, which predates the web manifest and still wins on
   * iPhone.
   *
   * Safari reads `apple-mobile-web-app-capable` rather than the manifest's
   * `display` when deciding whether a home-screen launch opens in its own
   * window or in a Safari tab, so without this the whole standalone experience
   * simply does not happen on the one platform most likely to be holding this
   * app.
   *
   * `statusBarStyle: "default"` rather than `black-translucent`. Translucent
   * puts the page *under* the status bar, which sounds like the more immersive
   * choice and is the wrong one here: the dashboard's own header would slide
   * beneath the clock. `viewportFit: "cover"` plus the safe-area padding the
   * layout already applies is how this app reaches the edges, and the two
   * approaches conflict.
   */
  appleWebApp: {
    capable: true,
    title: SITE_NAME,
    statusBarStyle: "default",
  },
  /** Stops iOS turning anything that looks like a phone number into a link —
   *  a video's duration ("12 05") and a render's stats read as one often
   *  enough to matter, and a tel: link inside a table is a tap that goes
   *  nowhere useful. */
  formatDetection: { telephone: false },
  keywords: [
    "automated video production",
    "YouTube automation",
    "AI video generation",
    "faceless YouTube channel",
    "text to video",
    "AI narration",
    "YouTube Shorts automation",
    "self-hosted video pipeline",
  ],
  authors: [{ name: SITE_NAME, url: SITE_URL }],
  creator: SITE_NAME,
  publisher: SITE_NAME,
  category: "technology",
  // The canonical URL every page inherits unless it declares its own.
  //
  // `/privacy`, `/terms` and `/contact` each override it with a
  // self-referencing canonical via `pageMetadata()`. The auth and dashboard
  // routes do not, so they inherit `/` — which happens to be the outcome we
  // want for them anyway: there is no public self-registration here, so a
  // sign-in form has no business ranking as a page of its own, and pointing it
  // at the homepage consolidates it rather than competing with it.
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    url: SITE_URL,
    title: SITE_TAGLINE,
    description: SITE_DESCRIPTION,
    locale: SITE_LOCALE,
    // The image itself is supplied by the `opengraph-image.tsx` file
    // convention, which also fills in `twitter:image`. Listing it here as well
    // would emit it twice.
    //
    // `url` above is the homepage, and this whole block is inherited rather
    // than derived, so a sub-page that does not restate it would share as the
    // homepage. `pageMetadata()` is what restates it — see the note there.
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TAGLINE,
    description: SITE_DESCRIPTION,
    // No `site`/`creator`: Framecast has no X account. An @handle that does not
    // resolve is a fabricated claim in the one place a scraper checks it.
  },
  // The dashboard is operator-only and blocked in robots.ts; this is the
  // belt-and-braces for the public pages that *should* be indexed. The
  // `googleBot` block is what actually earns the large thumbnail in Search and
  // Discover — the default is a 0-pixel preview for image and video, so the
  // OpenGraph card below would never be shown at size without it.
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
};

/**
 * `viewport-fit=cover` is what makes `env(safe-area-inset-*)` resolve to
 * anything but zero on an iPhone — without it every one of those insets reads
 * as 0px and the bars that use them sit under the home indicator.
 *
 * It lives at the root because both halves of the app now need it: the studio
 * has its floating dock, and the public pages have theirs. The studio's layout
 * still declares it as well, which is a no-op repeat rather than a conflict —
 * viewport is merged per field down the tree — and is worth keeping, because it
 * is what stops a future change here from silently unpinning that dock.
 */
export const viewport: Viewport = {
  viewportFit: "cover",
  /**
   * The colour the browser paints its own chrome — the status bar on an
   * installed Android app, the address bar on Chrome, the notch surround when
   * `viewportFit: "cover"` lets the page under it.
   *
   * Two entries rather than one, matched to `prefers-color-scheme`, because a
   * single value is wrong half the time: a dark bar above a light page reads as
   * a rendering fault, and a light bar above a dark page is the flash of white
   * people describe as "it still feels like a web page".
   *
   * The values are the base `--background` token for each scheme —
   * `oklch(1 0 0)` and `oklch(0.145 0 0)` in globals.css. An accent shifts that
   * token by a few hundredths of a percent (`oklch(0.995 0.004 285)` and
   * friends), which is below the threshold anyone can see against the page it
   * sits above, and a per-accent colour cannot be expressed in a static meta
   * tag anyway.
   *
   * next-themes can also resolve to a *chosen* theme that disagrees with the
   * system one. That case is not covered here and cannot be: this is a static
   * meta tag emitted on the server, and the alternative — a client effect
   * rewriting it after hydration — would paint the wrong colour first anyway.
   */
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
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
        <SiteStructuredData />
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
