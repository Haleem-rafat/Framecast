-- The motion tier: the first thing in this app that generates video.
--
-- Two things arrive together because neither is useful alone — a provider slot
-- to hang a credential on, and a table to hold a generation that takes minutes
-- rather than milliseconds.
--
-- ## Why a new enum value and not one of the six already there
--
-- "AiProviderType" already lists GOOGLE_VEO, RUNWAY, KLING, REPLICATE, PIKA and
-- LUMA. Every one of them appears in exactly three places in this codebase —
-- the enum, provider-labels.ts and provider.schema.ts — and nowhere else. They
-- are names, not integrations. Reusing one would mean an operator storing a key
-- labelled "Runway" that is sent to fal.ai, which is a lie told in the one place
-- an operator goes to audit what this app can spend. FAL is a seventh name with
-- an adapter behind it.
--
-- Postgres permits ALTER TYPE ... ADD VALUE inside a transaction (PG 12+) only
-- as long as nothing in the same transaction *uses* the new value. Nothing below
-- does: "motion_clip_job" references "MotionClipStatus", never
-- "AiProviderType". The provider is recorded on "provider_usage" rows written
-- at runtime, long after this transaction has committed.
ALTER TYPE "AiProviderType" ADD VALUE 'FAL';

-- WAITING and SUBMITTED are both "not finished". The difference is whether the
-- provider has started billing: a WAITING row has been sent nowhere, a SUBMITTED
-- row names a generation already running under "requestId".
CREATE TYPE "MotionClipStatus" AS ENUM ('WAITING', 'CLAIMED', 'SUBMITTED', 'DONE', 'FAILED');

-- One generated clip, from before it is submitted to after it is stored.
--
-- A table rather than an await inside a request, and the reason is measured
-- rather than defensive: one 5-second clip took 217 seconds to come back. A
-- twelve-clip manifest is three quarters of an hour of wall time. So this is
-- the same shape "auto_publish_job" already uses — a row, a lease and a worker
-- tick — and not the shape every other provider in this codebase uses.
--
-- "seed" is the column the whole design turns on. Video generation has a real
-- reject rate; without a stored seed the only way to fix one bad clip out of
-- twelve is to buy all twelve again. render-manifest.ts refuses a manifest whose
-- clips have no integer seed for exactly this reason, and this is where that
-- seed comes to rest.
--
-- "billedSeconds" is seconds, not dollars, and that is not squeamishness. There
-- is no price endpoint on fal.ai — rest.alpha.fal.ai/billing/* is a 404 — so any
-- dollar figure stored here would be a guess with a decimal point on it. The
-- spend ceiling this app enforces is denominated in these seconds; dollars are
-- shown as an estimate from an operator-maintained constant and never written
-- down as fact.
CREATE TABLE "motion_clip_job" (
  "id"              UUID NOT NULL,
  "videoId"         UUID NOT NULL,
  "userId"          UUID NOT NULL,
  "clipId"          INTEGER NOT NULL,
  "slotIndex"       INTEGER NOT NULL,
  "model"           TEXT NOT NULL,
  "prompt"          TEXT NOT NULL,
  "negativePrompt"  TEXT,
  "aspectRatio"     TEXT NOT NULL,
  "durationSeconds" DOUBLE PRECISION NOT NULL,
  "seed"            INTEGER NOT NULL,
  "billedSeconds"   INTEGER NOT NULL,
  "status"          "MotionClipStatus" NOT NULL DEFAULT 'WAITING',
  "attempts"        INTEGER NOT NULL DEFAULT 0,
  "requestId"       TEXT,
  "submittedAt"     TIMESTAMP(3),
  "storagePath"     TEXT,
  "runAfter"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseExpiresAt"  TIMESTAMP(3),
  "error"           TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "motion_clip_job_pkey" PRIMARY KEY ("id")
);

-- Enqueueing the same manifest twice must be a no-op, not a second bill. The
-- claim's conditional update guards the race between two workers; this guards a
-- caller that submits the same manifest again.
CREATE UNIQUE INDEX "motion_clip_job_videoId_clipId_key" ON "motion_clip_job"("videoId", "clipId");

-- The claim query scans exactly this: due jobs, oldest first.
CREATE INDEX "motion_clip_job_status_runAfter_idx" ON "motion_clip_job"("status", "runAfter");

-- "What did this video's motion tier cost, and has it finished" — the summary
-- an operator reads before and after the spend.
CREATE INDEX "motion_clip_job_videoId_status_idx" ON "motion_clip_job"("videoId", "status");

-- Cascade on both, for the reason every other direct relation off "user" and
-- "video" cascades: a deleted video has no clips to generate, and a deleted
-- account's queue must not outlive it (src/test/fixtures.ts depends on this).
ALTER TABLE "motion_clip_job"
  ADD CONSTRAINT "motion_clip_job_videoId_fkey"
  FOREIGN KEY ("videoId") REFERENCES "video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "motion_clip_job"
  ADD CONSTRAINT "motion_clip_job_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
