import type { MetadataRoute } from "next";

import { SITE_URL } from "@/config/site";

/**
 * Only the three public routes. The dashboard is operator-only and disallowed
 * in robots.ts — listing it here would contradict that, and a sitemap that
 * points at pages a crawler is told not to fetch is worse than one that omits
 * them.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return [
    { url: SITE_URL, lastModified, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/privacy`, lastModified, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/terms`, lastModified, changeFrequency: "yearly", priority: 0.3 },
  ];
}
