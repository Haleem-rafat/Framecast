-- The shorts drip: a per-channel release cadence, and the history of every
-- slot it came round for.
--
-- Purely additive. Two tables, no new enums, and no change to any existing
-- column — an account that existed before this migration simply has no
-- cadences, which is exactly what "never set one up" means. The only edits to
-- existing tables are foreign keys pointing *into* the new ones, so nothing on
-- user, channel or short moves.
--
-- No new enums on purpose. `ScheduleStatus` and `ScheduleRunOutcome` already
-- describe these two states and these four outcomes, and they describe them the
-- same way: ACTIVE/PAUSED with a reason on the row, and SUCCEEDED/SKIPPED/
-- FAILED/MISSED where SKIPPED means "we looked and there was a reason not to"
-- and MISSED means "nothing looked at all". Minting `ReleaseCadenceStatus` and
-- `ReleaseRunOutcome` with identical members would be two more types to keep in
-- step for no behaviour.
--
-- Note what is *not* here: no `DAILY` added to `ScheduleFrequency`, and no
-- column on `schedule`. A schedule produces (a model call, a narration, a
-- render, a bill); a cadence releases something already paid for. They share
-- their timing discipline and nothing else. See the doc comments on
-- `ReleaseCadence` in schema.prisma.
--
-- Three constraints below are load-bearing rather than tidiness:
--
--   * `release_cadence_status_nextReleaseAt_idx` is the due-check's candidate
--     scan. Without it the worker sequentially scans every cadence on every
--     poll, alongside renders, on two vCPUs.
--   * `release_cadence_channelId_key` is what makes "one cadence per channel"
--     true rather than merely intended. Two cadences on one channel would race
--     for the same queue of banked shorts with no rule for who wins.
--   * `release_run_cadenceId_scheduledFor_key` is the last line of defence
--     against releasing the same slot twice. The claim is won with a
--     conditional update on `nextReleaseAt` (see ReleaseService.claimDue),
--     which is what actually prevents it; this constraint means that if that
--     ever failed, the second release's history insert would fail before a
--     single byte reached YouTube — and an upload, unlike a billed run, cannot
--     be undone from this app at all.

-- CreateTable
CREATE TABLE "release_cadence" (
    "id" UUID NOT NULL,
    "status" "ScheduleStatus" NOT NULL DEFAULT 'ACTIVE',
    "pausedReason" TEXT,
    -- Minutes past local midnight, ascending and distinct. An array rather than
    -- a child table because a slot has no state of its own: which occurrence is
    -- next is a property of the whole set, and there is nothing per-slot to
    -- claim, lease or count.
    "slotMinutes" INTEGER[],
    "timeZone" TEXT NOT NULL,
    "visibility" "PublishVisibility" NOT NULL DEFAULT 'PUBLIC',
    "nextReleaseAt" TIMESTAMP(3),
    "lastReleaseAt" TIMESTAMP(3),
    "claimExpiresAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" UUID NOT NULL,
    "channelId" UUID NOT NULL,

    CONSTRAINT "release_cadence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_run" (
    "id" UUID NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "outcome" "ScheduleRunOutcome" NOT NULL,
    "reason" TEXT,
    "shortTitle" TEXT,
    "youtubeVideoId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cadenceId" UUID NOT NULL,
    "shortId" UUID,

    CONSTRAINT "release_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "release_cadence_channelId_key" ON "release_cadence"("channelId");

-- CreateIndex
CREATE INDEX "release_cadence_status_nextReleaseAt_idx" ON "release_cadence"("status", "nextReleaseAt");

-- CreateIndex
CREATE INDEX "release_cadence_userId_idx" ON "release_cadence"("userId");

-- CreateIndex
CREATE INDEX "release_run_cadenceId_createdAt_idx" ON "release_run"("cadenceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "release_run_cadenceId_scheduledFor_key" ON "release_run"("cadenceId", "scheduledFor");

-- AddForeignKey
ALTER TABLE "release_cadence" ADD CONSTRAINT "release_cadence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_cadence" ADD CONSTRAINT "release_cadence_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_run" ADD CONSTRAINT "release_run_cadenceId_fkey" FOREIGN KEY ("cadenceId") REFERENCES "release_cadence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_run" ADD CONSTRAINT "release_run_shortId_fkey" FOREIGN KEY ("shortId") REFERENCES "short"("id") ON DELETE SET NULL ON UPDATE CASCADE;
