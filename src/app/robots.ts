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
 */
const OPERATOR_ROUTES = [
  "/dashboard",
  "/videos",
  "/projects",
  "/channels",
  "/providers",
  "/prompts",
  "/api",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: OPERATOR_ROUTES.map((route) => `${route}/`),
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
