/**
 * Single source of truth for the production origin. Used by root metadata,
 * `robots.ts`, `sitemap.ts` and the generated OpenGraph image — all of which
 * need an absolute URL and must agree on the same one.
 */
export const SITE_URL = "https://framecasts.com";
export const SITE_NAME = "Framecast";

/**
 * The one-sentence description reused by the page `<meta>` tags, the OpenGraph
 * and Twitter cards, and the JSON-LD graph. Kept here so a scraper, a search
 * engine and a link preview never disagree about what this thing is.
 *
 * Every clause is something the codebase actually does. Nothing aspirational.
 */
export const SITE_DESCRIPTION =
  "Framecast turns a topic into a finished YouTube video — a sourced script, " +
  "narration, footage matched to every line, burned-in captions and a music " +
  "bed — and holds it for your approval before anything is published.";

/** Used as the `<title>` default and as the OpenGraph/Twitter card title. */
export const SITE_TAGLINE = `${SITE_NAME} — automated YouTube video production`;

/**
 * The operator's address, already published in the privacy policy and on the
 * contact page. Repeated in the JSON-LD `contactPoint` so the structured data
 * points at the same real inbox the pages do, rather than inventing a support
 * desk that does not exist.
 */
export const OPERATOR_EMAIL = "eramdevteam@gmail.com";
