/**
 * Turning a logo's storage path into something an `<img>` can point at.
 *
 * A client-safe module, for the same reason `footage-styles.ts` is one: the
 * gallery that renders these is a client component and `src/lib/storage.ts`
 * — where the paths come from — is `server-only`.
 *
 * Storage paths look like `videos/<channelId>/logos/logo-<batch>-<index>.png`
 * (`storagePath`'s `videos/` prefix is historical; the owner id there is a
 * channel). Only the last segment travels in the URL: the route rebuilds the
 * rest with `storagePath` after proving the channel is the operator's, so a
 * path from the browser is never trusted. See
 * `src/app/(dashboard)/channels/[id]/logo/[filename]/route.ts`.
 */

/** The last segment of a storage path, which is the only part the URL carries. */
export function logoFilename(logoPath: string): string {
  return logoPath.slice(logoPath.lastIndexOf("/") + 1);
}

/** Where to point an `<img>` at one of this channel's logo objects. */
export function logoImageUrl(channelId: string, logoPath: string): string {
  return `/channels/${channelId}/logo/${encodeURIComponent(logoFilename(logoPath))}`;
}
