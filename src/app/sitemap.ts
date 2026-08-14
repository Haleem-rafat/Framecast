import type { MetadataRoute } from "next";

import { SITE_URL } from "@/config/site";

/**
 * The four routes that render for a signed-out visitor: the landing page and
 * the three documents linked from its footer.
 *
 * Nothing under `(dashboard)` is listed — it is operator-only and disallowed in
 * robots.ts, and a sitemap that points at pages a crawler is told not to fetch
 * is worse than one that omits them. Nothing under `(auth)` is listed either:
 * those pages are reachable but there is no public sign-up, so they have no
 * business ranking, and the root layout already canonicalises them to `/`.
 *
 * `lastModified` is the build time. These are hand-edited documents with no
 * stored revision date, so the honest signal is "as of this deploy" rather
 * than a fixed date that would go stale the moment the text changes.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return [
    { url: SITE_URL, lastModified, changeFrequency: "weekly", priority: 1 },
    {
      url: `${SITE_URL}/contact`,
      lastModified,
      changeFrequency: "yearly",
      priority: 0.5,
    },
    {
      url: `${SITE_URL}/privacy`,
      lastModified,
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${SITE_URL}/terms`,
      lastModified,
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];
}
