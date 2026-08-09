-- DropForeignKey
ALTER TABLE "asset" DROP CONSTRAINT "asset_videoId_fkey";

-- DropIndex
DROP INDEX "asset_videoId_kind_idx";

-- DropIndex
DROP INDEX "asset_videoId_provider_externalId_key";

-- AlterTable
ALTER TABLE "asset" DROP COLUMN "videoId";
