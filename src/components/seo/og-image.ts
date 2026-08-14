/**
 * The shared facts about the generated OpenGraph card.
 *
 * `src/app/opengraph-image.tsx` re-exports `size`, `contentType` and `alt`
 * from here because Next.js reads those three exports off that module to build
 * the `og:image:width`/`height`/`type`/`alt` tags. `page-metadata.ts` reads the
 * same constants to describe the image by hand on sub-pages, which it has to
 * do (see the note there). Two descriptions of one image, from one definition.
 */
export const OG_IMAGE_SIZE = { width: 1200, height: 630 };

export const OG_IMAGE_CONTENT_TYPE = "image/png";

/** The route Next.js serves the generated card from. */
export const OG_IMAGE_PATH = "/opengraph-image";

/**
 * Describes the card for a screen reader and for anyone whose client shows alt
 * text instead of the image. It says what the card says.
 */
export const OG_IMAGE_ALT =
  "Framecast — topic in, finished YouTube video out, with a human review before anything publishes.";
