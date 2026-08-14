-- Recurring, scheduled video automation: a schedule, the queue of topics it
-- draws from, and the history of every occurrence.
--
-- Purely additive. Three enums, three tables, and no change to any existing
-- column — an account that existed before this migration simply has no
-- schedules, which is exactly what "never set one up" means. The only edits to
-- existing tables are the back-relations Prisma needs, and those are foreign
-- keys pointing *into* the new tables, so nothing on user/project/video moves.
--
-- Two constraints below are load-bearing rather than tidiness:
--
--   * `schedule_status_nextRunAt_idx` is the due-check's candidate scan. Without
--     it the worker sequentially scans every schedule every thirty seconds.
--   * `schedule_run_scheduleId_scheduledFor_key` is the last line of defence
--     against a double fire. The claim is won with a conditional update on
--     `nextRunAt` (see ScheduleService.claimDue), which is what actually
--     prevents it; this constraint means that if that ever failed, the second
--     run's history insert would fail before any provider was called, so the
--     worst case is a logged error rather than an operator billed twice.

-- CreateEnum
CREATE TYPE "ScheduleFrequency" AS ENUM ('WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('ACTIVE', 'PAUSED');

-- CreateEnum
CREATE TYPE "ScheduleRunOutcome" AS ENUM ('SUCCEEDED', 'SKIPPED', 'FAILED', 'MISSED');

-- CreateTable
CREATE TABLE "schedule" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ScheduleStatus" NOT NULL DEFAULT 'ACTIVE',
    "pausedReason" TEXT,
    "frequency" "ScheduleFrequency" NOT NULL,
    "dayOfWeek" INTEGER,
    "dayOfMonth" INTEGER,
    "hour" INTEGER NOT NULL,
    "minute" INTEGER NOT NULL,
    "timeZone" TEXT NOT NULL,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "nextRunAt" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "claimExpiresAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "userId" UUID NOT NULL,
    "projectId" UUID NOT NULL,

    CONSTRAINT "schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_topic" (
    "id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "topic" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduleId" UUID NOT NULL,

    CONSTRAINT "schedule_topic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_run" (
    "id" UUID NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "outcome" "ScheduleRunOutcome" NOT NULL,
    "reason" TEXT,
    "topic" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduleId" UUID NOT NULL,
    "videoId" UUID,

    CONSTRAINT "schedule_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "schedule_status_nextRunAt_idx" ON "schedule"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "schedule_userId_deletedAt_idx" ON "schedule"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "schedule_topic_scheduleId_consumedAt_position_idx" ON "schedule_topic"("scheduleId", "consumedAt", "position");

-- CreateIndex
CREATE INDEX "schedule_run_scheduleId_createdAt_idx" ON "schedule_run"("scheduleId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_run_scheduleId_scheduledFor_key" ON "schedule_run"("scheduleId", "scheduledFor");

-- AddForeignKey
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_topic" ADD CONSTRAINT "schedule_topic_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_run" ADD CONSTRAINT "schedule_run_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_run" ADD CONSTRAINT "schedule_run_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "video"("id") ON DELETE SET NULL ON UPDATE CASCADE;
