-- The analytics collector's bookkeeping: one row per channel saying when it was
-- last collected, how far back the backfill has walked, and why it stopped.
--
-- Purely additive. One table, no new enums, and no change to any existing
-- column. `channel_statistic` and `video_analytic` already exist and are
-- untouched by this migration — they have simply never had a writer, which is
-- what the collector this table serves now provides.
--
-- A channel that existed before this migration gets no row here. That is the
-- correct state and not a backfill gap: `ChannelAnalyticsService.claimDue`
-- treats a missing row as "due now" (see its left-join over channels), so the
-- first tick after deploy creates the row and collects. Seeding rows here would
-- make every connected channel due in the same instant, which is precisely the
-- burst the backfill design exists to avoid.
--
-- Two constraints below are load-bearing rather than tidiness:
--
--   * `channel_collection_channelId_key` is what makes "one collection state
--     per channel" true rather than merely intended. Two rows would let two
--     workers each hold a valid claim on the same channel and write the same
--     `video_analytic` days twice — which the `[publicationId, capturedFor]`
--     unique index would then reject, turning a duplicate into a failed
--     collection rather than a silent doubling. This constraint stops it a
--     level earlier.
--
--   * `channel_collection_nextCollectionAt_idx` is the due-check's candidate
--     scan. It runs on the worker's idle poll alongside renders on two vCPUs;
--     without the index it is a sequential scan of every channel every time.

-- CreateTable
CREATE TABLE "channel_collection" (
    "id" UUID NOT NULL,
    "nextCollectionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimExpiresAt" TIMESTAMP(3),
    "lastCollectedAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "backfilledThrough" DATE,
    "backfillComplete" BOOLEAN NOT NULL DEFAULT false,
    "revenueAvailable" BOOLEAN,
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "channelId" UUID NOT NULL,

    CONSTRAINT "channel_collection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "channel_collection_channelId_key" ON "channel_collection"("channelId");

-- CreateIndex
CREATE INDEX "channel_collection_nextCollectionAt_idx" ON "channel_collection"("nextCollectionAt");

-- AddForeignKey
ALTER TABLE "channel_collection" ADD CONSTRAINT "channel_collection_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
