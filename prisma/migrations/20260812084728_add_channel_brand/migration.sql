-- CreateTable
CREATE TABLE "channel_brand" (
    "id" UUID NOT NULL,
    "videoStyle" JSONB,
    "logoPath" TEXT,
    "primaryColour" TEXT,
    "secondaryColour" TEXT,
    "headlineFont" TEXT,
    "tone" TEXT,
    "niche" TEXT,
    "musicQuery" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "channelId" UUID NOT NULL,

    CONSTRAINT "channel_brand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "channel_brand_channelId_key" ON "channel_brand"("channelId");

-- AddForeignKey
ALTER TABLE "channel_brand" ADD CONSTRAINT "channel_brand_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
