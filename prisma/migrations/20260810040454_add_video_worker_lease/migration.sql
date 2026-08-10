-- AlterTable
ALTER TABLE "video" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cancelRequestedAt" TIMESTAMP(3),
ADD COLUMN     "leaseExpiresAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "video_status_leaseExpiresAt_idx" ON "video"("status", "leaseExpiresAt");
