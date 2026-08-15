-- Shorts can be published now, which reverses a decision this schema used to
-- enforce. `ShortStatus` was written with no PUBLISHED member on purpose, so
-- that "nothing in this codebase moves a Short past READY" was a constraint
-- rather than an omission. The operator has asked for the opposite: the publish
-- dialog now offers "also publish these shorts" as an explicit, off-by-default
-- choice, and the video and its READY shorts go up in the same click.
--
-- What the reversal keeps is the part that mattered — nothing reaches YouTube
-- unless the operator ticks that box. `/automation` and the schedules still
-- stop at a READY video, and publish.service.ts is still reachable only from
-- the button.
--
-- Purely additive: one new table, no change to any existing one, and no enum
-- member added to "ShortStatus". That enum still tracks the encode (queued,
-- being cut, cut, failed) and a published short is still a cut short with a
-- playable file underneath it. The upload is recorded here instead.
--
-- The `@unique` on "shortId" is the point of the table rather than a detail of
-- it. Publishing a short is one-shot for the same reason publishing a video is,
-- and the way publish.service.ts enforces that for a video is to INSERT the
-- claim row before a single byte is sent — two concurrent publishes both reach
-- the insert, Postgres' unique index settles it, and only the winner ever calls
-- YouTube. "short_publication_shortId_key" below is that index for shorts.
--
-- No "scheduledFor" column: a short is published in the same click as its
-- parent video and inherits that publish's schedule and visibility outright, so
-- a column here could only ever disagree with the publication row beside it.
-- The reused "PublishStatus" enum already carries SCHEDULED for the case where
-- the parent publish was scheduled.

-- CreateTable
CREATE TABLE "short_publication" (
    "id" UUID NOT NULL,
    "youtubeVideoId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "visibility" "PublishVisibility" NOT NULL DEFAULT 'PRIVATE',
    "status" "PublishStatus" NOT NULL DEFAULT 'UPLOADING',
    "error" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "shortId" UUID NOT NULL,
    "channelId" UUID NOT NULL,

    CONSTRAINT "short_publication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "short_publication_shortId_key" ON "short_publication"("shortId");

-- CreateIndex
CREATE INDEX "short_publication_channelId_status_idx" ON "short_publication"("channelId", "status");

-- AddForeignKey
ALTER TABLE "short_publication" ADD CONSTRAINT "short_publication_shortId_fkey" FOREIGN KEY ("shortId") REFERENCES "short"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "short_publication" ADD CONSTRAINT "short_publication_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
