-- Why a published video's thumbnail did not reach YouTube.
--
-- `publication.thumbnailApplied` already existed and was already correct — it
-- read `false` for the first video this app ever published, whose thumbnail
-- YouTube refused. What it could not do is say *why*, or even distinguish
-- "this video had no thumbnail to attach" from "YouTube rejected the one it
-- had". The reason existed for exactly as long as one `console.error` line
-- survived in a container's log buffer; the container was recreated, and with
-- it went the only record of what went wrong. The operator's video is still
-- sitting on YouTube with an auto-chosen frame.
--
-- Nullable with no default and no backfill, deliberately. NULL means "nothing
-- to report", which is the truth for every row written before this column
-- existed: their outcome was never captured, and inventing a message for them
-- would put a sentence on the video page that nobody measured. The one already
-- affected row stays NULL and its retry — see `publishService.retryThumbnail`,
-- which this column is half of — is what will finally produce a real reason
-- for it.
ALTER TABLE "publication"
  ADD COLUMN "thumbnailError" TEXT;
