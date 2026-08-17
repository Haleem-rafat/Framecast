-- Videos that publish themselves.
--
-- Until now the studio's most automated path stopped one step short of the only
-- step that matters: a series rendered an episode at 06:00 on Monday and then
-- waited for somebody to open the app and press a button. `release_cadence` has
-- auto-published *shorts* since the release pack; this is the same idea for the
-- long videos those clips are cut from.
--
-- All four columns are additive with defaults, so there is no backfill and no
-- behaviour change for an existing row: every series and every schedule that
-- exists today comes out with "autoPublish" = false, which is exactly what they
-- do now. Nothing starts publishing itself because this migration ran.
ALTER TABLE "series"
  ADD COLUMN "autoPublish" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "publishVisibility" "PublishVisibility" NOT NULL DEFAULT 'PRIVATE';

-- The same two on a schedule, read only when it belongs to no series — a
-- series-owned schedule reads the show's. See `resolveAutoPublish`.
ALTER TABLE "schedule"
  ADD COLUMN "autoPublish" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "publishVisibility" "PublishVisibility" NOT NULL DEFAULT 'PRIVATE';

CREATE TYPE "AutoPublishStatus" AS ENUM ('WAITING', 'CLAIMED', 'DONE', 'FAILED');

-- One row per video made by an automation set to publish itself.
--
-- The unique constraint on "videoId" is a backstop behind the claim's
-- conditional update, not the mechanism: it makes a second enqueue of the same
-- video impossible even if a caller is written wrongly later. The stake is a
-- video uploaded to the same channel twice, and there is no unpublish path from
-- this app.
CREATE TABLE "auto_publish_job" (
  "id"             UUID NOT NULL,
  "videoId"        UUID NOT NULL,
  "userId"         UUID NOT NULL,
  "visibility"     "PublishVisibility" NOT NULL,
  "status"         "AutoPublishStatus" NOT NULL DEFAULT 'WAITING',
  "attempts"       INTEGER NOT NULL DEFAULT 0,
  "runAfter"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseExpiresAt" TIMESTAMP(3),
  "error"          TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "auto_publish_job_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "auto_publish_job_videoId_key" ON "auto_publish_job"("videoId");

-- The claim query scans exactly this: due jobs, oldest first.
CREATE INDEX "auto_publish_job_status_runAfter_idx" ON "auto_publish_job"("status", "runAfter");

-- Cascade on both, and neither is a judgement call. A deleted video cannot
-- publish, and a deleted account's queue must not outlive it — every direct
-- relation off "user" already cascades for that reason (see
-- src/test/fixtures.ts, which depends on it).
ALTER TABLE "auto_publish_job"
  ADD CONSTRAINT "auto_publish_job_videoId_fkey"
  FOREIGN KEY ("videoId") REFERENCES "video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "auto_publish_job"
  ADD CONSTRAINT "auto_publish_job_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
