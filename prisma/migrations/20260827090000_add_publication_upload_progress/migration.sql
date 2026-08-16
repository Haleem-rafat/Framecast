-- What a publish knows about itself while it is running, and after it stops
-- running for the wrong reason.
--
-- Purely additive: four nullable-or-defaulted columns on an existing table, no
-- new enum values, no constraint changed. In particular `publication_videoId_key`
-- is untouched — that unique index is the duplicate-upload guard (Gate 2), and
-- nothing here relaxes it. A stuck row is still a row that blocks a retry; what
-- changes is that the operator can now see it is stuck and remove it
-- deliberately, instead of the video being unpublishable forever.
--
-- The incident: a 463MB render was published from inside the app container (the
-- publish is a Server Action), the container was restarted by a deploy while the
-- PUT was in flight, and a SIGKILL runs no `catch`. The row was left `UPLOADING`
-- with a null `youtubeVideoId`, a null `error`, and an `updatedAt` that never
-- moved off `createdAt` — indistinguishable, from every screen in the app, from
-- an upload that was simply still going.
--
--   * "uploadedBytes"/"totalBytes" are the measurement that ends that ambiguity
--     for a *live* upload: bytes YouTube has confirmed it holds, against the
--     size of the file being sent. INTEGER caps them near 2GB, which is an order
--     of magnitude above the largest render this app has produced; BIGINT was
--     rejected because these values are read by a client component through a
--     Server Action, and a JS BigInt is not serialisable across that boundary.
--
--   * "uploadStartedAt" is when bytes began moving, deliberately not `createdAt`
--     — the claim row is taken before the OAuth token is resolved and before the
--     render is opened. Every rate and every "about N minutes left" shown to the
--     operator is measured from this column, so it has to mean the upload rather
--     than the attempt.
--
--   * "leaseExpiresAt" is the liveness signal, and it is the same mechanism
--     "video"."leaseExpiresAt" already provides for renders. It is renewed on a
--     30-second timer for as long as the publishing process lives, so a slow
--     upload keeps its lease and only a dead process loses one.
--
-- Existing rows get NULL for all three timestamps/sizes and 0 for
-- "uploadedBytes". For any historical `UPLOADING` row that is exactly right: a
-- null lease reads as "not heartbeating", which is the truth about a process
-- that no longer exists. Backfilling a lease would have made the operator's one
-- genuinely stuck row look alive.
--
-- No index is added. Every read of these columns is by `videoId`, which is
-- already uniquely indexed; nothing scans for stalled publications, because
-- nothing is permitted to act on one without the operator.

-- AlterTable
ALTER TABLE "publication" ADD COLUMN     "uploadedBytes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totalBytes" INTEGER,
ADD COLUMN     "uploadStartedAt" TIMESTAMP(3),
ADD COLUMN     "leaseExpiresAt" TIMESTAMP(3);
