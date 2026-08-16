/**
 * Turning a character sheet's storage path into something an `<img>` can point
 * at.
 *
 * A client-safe module for the same reason `channel-logo.ts` is one: the
 * branding screen that renders these is a client component and
 * `src/lib/storage.ts` — where the paths come from — is `server-only`.
 *
 * Paths look like `videos/<channelId>/characters/sheet-<token>.png`
 * (`storagePath`'s `videos/` prefix is historical; the owner id there is a
 * channel). Only the last segment travels in the URL: the route rebuilds the
 * rest with `storagePath` after proving the channel is the operator's, so a
 * path from the browser is never trusted. See
 * `src/app/(dashboard)/channels/[id]/character/[filename]/route.ts`.
 */

/** The last segment of a storage path, which is the only part the URL carries. */
export function characterSheetFilename(sheetPath: string): string {
  return sheetPath.slice(sheetPath.lastIndexOf("/") + 1);
}

/** Where to point an `<img>` at this channel's character sheet. */
export function characterSheetUrl(channelId: string, sheetPath: string): string {
  return `/channels/${channelId}/character/${encodeURIComponent(characterSheetFilename(sheetPath))}`;
}
