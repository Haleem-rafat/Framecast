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
 * How a sub-page's title is joined to the site name.
 *
 * The root layout hands this to `metadata.title.template`, which Next.js only
 * applies to the `<title>` element — `og:title` and `twitter:title` are never
 * templated. `pageMetadata()` in `@/components/seo/page-metadata` fills it in
 * by hand for those, which is only correct as long as both read the same
 * string from here.
 */
export const TITLE_TEMPLATE = `%s · ${SITE_NAME}`;

/**
 * The OpenGraph locale. Stated in one place because the root layout and
 * `pageMetadata()` both emit an `og:locale` and a scraper that saw two
 * different ones across the same site would be right to distrust both.
 */
export const SITE_LOCALE = "en_GB";

/**
 * The operator's address, already published in the privacy policy and on the
 * contact page. Repeated in the JSON-LD `contactPoint` so the structured data
 * points at the same real inbox the pages do, rather than inventing a support
 * desk that does not exist.
 */
export const OPERATOR_EMAIL = "eramdevteam@gmail.com";

/**
 * The operator's second inbox, listed alongside the first everywhere a human
 * is invited to write in. Both are real and both are read.
 *
 * Two addresses rather than one because a privacy policy's contact route is the
 * one promise on the page that has to survive a mailbox going unread — a data
 * deletion request that bounces is a compliance failure, not an inconvenience.
 */
export const OPERATOR_EMAIL_ALT = "haleem.rafat@gmail.com";

/** Every address a visitor may use to reach the operator, in the order shown. */
export const OPERATOR_EMAILS = [OPERATOR_EMAIL, OPERATOR_EMAIL_ALT] as const;
