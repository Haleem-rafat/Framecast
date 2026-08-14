import type { Metadata } from "next";

import {
  OG_IMAGE_ALT,
  OG_IMAGE_CONTENT_TYPE,
  OG_IMAGE_PATH,
  OG_IMAGE_SIZE,
} from "@/components/seo/og-image";
import { SITE_LOCALE, SITE_NAME, TITLE_TEMPLATE } from "@/config/site";

type PageMetadataInput = {
  /** The page title, without the site name — the template appends that. */
  title: string;
  /** One sentence. Becomes `<meta name="description">` and the card text. */
  description: string;
  /** Root-relative path, e.g. `/privacy`. Resolved against `metadataBase`. */
  path: `/${string}`;
};

/**
 * The card image, described by hand.
 *
 * On the homepage this is supplied automatically by the `opengraph-image.tsx`
 * file convention, and that version carries a content-hash query string which
 * is worth having: it is what makes Facebook and LinkedIn drop a stale cached
 * card when the artwork changes. That hash is not available to us here, so
 * sub-pages point at the un-suffixed route. Both are the same 200.
 */
const OG_IMAGE = {
  url: OG_IMAGE_PATH,
  width: OG_IMAGE_SIZE.width,
  height: OG_IMAGE_SIZE.height,
  type: OG_IMAGE_CONTENT_TYPE,
  alt: OG_IMAGE_ALT,
};

/**
 * Builds the metadata for a public sub-page.
 *
 * This exists because of how Next.js merges metadata down the tree: field by
 * field at the top level, and *replacing* rather than merging each one. Two
 * consequences, both invisible until something external fetches the page.
 *
 * 1. `alternates.canonical` is inherited. The root layout sets it to `/` so
 *    the auth routes, which do not declare their own, consolidate onto the
 *    homepage. Any other page that fails to override it therefore tells Google
 *    it is a duplicate of the homepage.
 *
 * 2. `openGraph` is inherited as one object, and none of it is derived from
 *    the page's own `title`/`description` the way `<title>` is. A page that
 *    sets only `title` and `description` still emits the layout's `og:title`,
 *    `og:description` and — worst of the three — the layout's `og:url`: every
 *    share of /privacy would announce itself as the homepage. But the moment a
 *    page declares any `openGraph` of its own, it replaces the layout's
 *    entirely, taking `og:site_name`, `og:locale`, `og:type` and the
 *    file-convention `og:image` with it. Same for `twitter`, where the
 *    casualty is `twitter:card` silently dropping back to `summary`.
 *
 * So the whole block has to be restated, and every value in it comes from a
 * shared constant rather than a literal, so the two statements of it cannot
 * drift apart.
 */
export function pageMetadata({
  title,
  description,
  path,
}: PageMetadataInput): Metadata {
  const fullTitle = TITLE_TEMPLATE.replace("%s", title);

  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      locale: SITE_LOCALE,
      title: fullTitle,
      description,
      url: path,
      images: [OG_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description,
      images: [OG_IMAGE],
    },
  };
}
