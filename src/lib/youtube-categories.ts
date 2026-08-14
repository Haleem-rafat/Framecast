/**
 * What a channel tells YouTube about every video it uploads, and the fallback
 * category list behind the picker that edits it.
 *
 * Here rather than in `brand.service.ts` for one reason: the dialog that edits
 * these is a client component, and that service imports `server-only`. Types
 * would erase, but `CURATED_CATEGORIES` is a value the picker renders on its
 * first frame. Same split, and the same reason, as `youtube-limits.ts`.
 */

/** The two per-channel publishing fields, as stored. */
export interface PublishingDefaults {
  /** BCP-47, e.g. `en`. */
  language: string;
  /** YouTube's numeric category id as a string, e.g. `"27"`. */
  categoryId: string;
}

/**
 * Mirrors the `language` and `categoryId` column defaults in
 * prisma/schema.prisma, and `BrandService`'s own FALLBACK. All three have to
 * agree: a channel that has never been branded, a brand row created before
 * these columns existed, and a channel with no brand row at all must publish
 * identically, with nothing asked of the operator.
 *
 * 27 is Education — see the column's comment in schema.prisma for why that and
 * not 28.
 */
export const PUBLISHING_DEFAULTS: PublishingDefaults = {
  language: "en",
  categoryId: "27",
};

/** One entry of what `videoCategories.list` returns, narrowed to what a picker
 *  needs. `id` is the numeric string the upload sends. */
export interface VideoCategory {
  id: string;
  title: string;
}

/**
 * Used only when `videoCategories.list` cannot be reached — see
 * `BrandService.listCategories`, which is where the picker's list normally
 * comes from.
 *
 * Every id here is one YouTube returns with `assignable: true` for
 * `regionCode=US`. The ids themselves are global (27 is Education
 * everywhere); it is only *which* of them are assignable that varies by
 * region. The non-assignable ones the same call returns — 18, 21 and 30-44 —
 * are deliberately absent: YouTube lists those so videos already filed under
 * them can be read, not so new ones can be filed there, and sending one makes
 * `videos.insert` answer 400 after the entire file has been uploaded.
 *
 * Source: YouTube Data API v3, `videoCategories.list?part=snippet&regionCode=US`.
 */
export const CURATED_CATEGORIES: readonly VideoCategory[] = [
  { id: "1", title: "Film & Animation" },
  { id: "2", title: "Autos & Vehicles" },
  { id: "10", title: "Music" },
  { id: "15", title: "Pets & Animals" },
  { id: "17", title: "Sports" },
  { id: "19", title: "Travel & Events" },
  { id: "20", title: "Gaming" },
  { id: "22", title: "People & Blogs" },
  { id: "23", title: "Comedy" },
  { id: "24", title: "Entertainment" },
  { id: "25", title: "News & Politics" },
  { id: "26", title: "Howto & Style" },
  { id: "27", title: "Education" },
  { id: "28", title: "Science & Technology" },
  { id: "29", title: "Nonprofits & Activism" },
];

/**
 * A category's name for display, for the one caller that has an id and no
 * list: the channel card, which would otherwise have to make two YouTube
 * calls to render one line of text.
 *
 * Falls back to naming the id rather than inventing a title. A channel set to
 * a category that only exists in its own region is exactly the case this
 * cannot resolve, and "Category 43" is honest where a guess would not be.
 */
export function categoryTitle(categoryId: string): string {
  return (
    CURATED_CATEGORIES.find((category) => category.id === categoryId)?.title ??
    `Category ${categoryId}`
  );
}
