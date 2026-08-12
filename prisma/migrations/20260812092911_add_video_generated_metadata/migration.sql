-- AlterTable
ALTER TABLE "video" ADD COLUMN     "generatedDescription" TEXT,
ADD COLUMN     "generatedTitle" TEXT,
ADD COLUMN     "tags" TEXT[];
