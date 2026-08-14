-- Vertical clips cut out of a finished video. See the Short model's comment in
-- schema.prisma for why the window is stored in source-video seconds rather than
-- as a character range into the script, and why there is no `deletedAt`.
--
-- Purely additive: a new enum, a new table, and no change to any existing one.
-- Nothing needs backfilling — a video that existed before this migration simply
-- has no shorts, which is exactly what "not generated yet" means.

-- CreateEnum
CREATE TYPE "ShortStatus" AS ENUM ('QUEUED', 'RENDERING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "short" (
    "id" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "startSeconds" DOUBLE PRECISION NOT NULL,
    "endSeconds" DOUBLE PRECISION NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "reason" TEXT,
    "status" "ShortStatus" NOT NULL DEFAULT 'QUEUED',
    "outputPath" TEXT,
    "error" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "videoId" UUID NOT NULL,

    CONSTRAINT "short_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "short_status_leaseExpiresAt_idx" ON "short"("status", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "short_videoId_index_key" ON "short"("videoId", "index");

-- AddForeignKey
ALTER TABLE "short" ADD CONSTRAINT "short_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
