import type { MetadataRoute } from "next";

import { SITE_URL } from "@/config/site";

/**
 * Everything behind auth is disallowed, not merely unlinked.
 *
 * These routes render an operator's own unpublished scripts, unreviewed
 * renders and provider settings. A crawler cannot sign in, so it would only
 * ever index the sign-in redirect — but a disallow is a stated boundary rather
 * than a coincidence of the auth check, and it keeps the URLs themselves out
 * of search results.
 *
 * Written without a trailing slash on purpose. `Disallow: /dashboard/` is a
 * prefix match on the literal string, so it covers `/dashboard/anything` but
 * leaves the bare `/dashboard` — the route that actually exists — crawlable.
 * Dropping the slash covers both.
 *
 * This list is every segment under `src/app/(dashboard)`, plus `/api`. It has
 * to be kept in step with that directory by hand; a route added there and not
 * added here is a route a crawler is invited into.
 */
const OPERATOR_ROUTES = [
  "/analytics",
  "/approvals",
  "/automation",
  "/channels",
  "/dashboard",
  "/logs",
  "/projects",
  "/prompts",
  "/providers",
  "/publishing",
  "/settings",
  "/studio",
  "/videos",
  "/api",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: OPERATOR_ROUTES,
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
