-- Series: a named, reusable production recipe for one recurring show.
--
-- Purely additive. One table, two nullable columns on existing tables, and no
-- change to any existing value. A deployment that never creates a series is
-- byte-for-byte the deployment it was before this ran:
--
--   * `video.seriesId` is NULL for every row that already exists, which is the
--     same thing it means going forward — "no show commissioned this".
--   * `schedule.seriesId` is NULL for every existing schedule, and the due-check
--     does not read the column at all. `ScheduleService.claimDue` still selects
--     ACTIVE schedules whose `nextRunAt` has arrived, still wins them with the
--     same conditional update on `nextRunAt`, and still advances with
--     `advancePast`. Nothing about the no-double-fire lock, the no-burst
--     recovery, the DST arithmetic or the pause-after-three-failures rule
--     changes shape here.
--
-- Two constraints are load-bearing rather than tidiness:
--
--   * `schedule_seriesId_key` is what makes "a show has one cadence" true in the
--     database rather than only in the service. Without it a bug could attach
--     two schedules to one series and produce two videos a week from a show the
--     operator set to weekly.
--   * `series_promptTemplateId_fkey` is ON DELETE RESTRICT. Prompt templates are
--     soft-deleted, so this never actually fires; it exists so that if anything
--     ever hard-deletes one, the database refuses rather than leaving a series
--     pointing at a script style that no longer resolves — which would surface
--     as a schedule failing at 09:00 on a Monday.
--
-- There is deliberately no `artStyle`, `voiceId`, `musicQuery`, `niche`, `tone`
-- or `footageStyle` column here. Those live on `channel_brand` and are resolved
-- through `video -> project -> channel` by the render, footage, publish and
-- shorts services; a copy on the series would be a value the screen shows and
-- the renderer ignores. A series inherits its channel's look, and two series on
-- one channel differ in script style, format, cadence and topic queue.

-- CreateTable
CREATE TABLE "series" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "format" "VideoFormat" NOT NULL DEFAULT 'LANDSCAPE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "userId" UUID NOT NULL,
    "channelId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "promptTemplateId" UUID NOT NULL,

    CONSTRAINT "series_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "video" ADD COLUMN "seriesId" UUID;

-- AlterTable
ALTER TABLE "schedule" ADD COLUMN "seriesId" UUID;

-- CreateIndex
CREATE INDEX "series_userId_deletedAt_idx" ON "series"("userId", "deletedAt");

-- CreateIndex
CREATE INDEX "series_userId_channelId_deletedAt_idx" ON "series"("userId", "channelId", "deletedAt");

-- CreateIndex
CREATE INDEX "video_seriesId_createdAt_idx" ON "video"("seriesId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_seriesId_key" ON "schedule"("seriesId");

-- AddForeignKey
ALTER TABLE "series" ADD CONSTRAINT "series_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "series" ADD CONSTRAINT "series_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "series" ADD CONSTRAINT "series_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "series" ADD CONSTRAINT "series_promptTemplateId_fkey" FOREIGN KEY ("promptTemplateId") REFERENCES "prompt_template"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video" ADD CONSTRAINT "video_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "series"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule" ADD CONSTRAINT "schedule_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "series"("id") ON DELETE CASCADE ON UPDATE CASCADE;
