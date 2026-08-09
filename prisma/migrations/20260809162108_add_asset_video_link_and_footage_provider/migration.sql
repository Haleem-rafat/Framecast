-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AiProviderType" ADD VALUE 'PEXELS';
ALTER TYPE "AiProviderType" ADD VALUE 'PIXABAY';

-- AlterTable
ALTER TABLE "asset" ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "videoId" UUID;

-- CreateIndex
CREATE INDEX "asset_videoId_kind_idx" ON "asset"("videoId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "asset_videoId_provider_externalId_key" ON "asset"("videoId", "provider", "externalId");

-- AddForeignKey
ALTER TABLE "asset" ADD CONSTRAINT "asset_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
