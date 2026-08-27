-- Mean share of each video watched per view, 0-100, from the YouTube Analytics
-- API's `averageViewPercentage`.
--
-- Backfilled as 0 rather than NULL. Every other figure on this table treats an
-- absent day as nothing-happened, and a nullable column here would make every
-- reader downstream decide again what "no retention recorded" means. Rows
-- written before this migration simply never carried the figure; the collector
-- rewrites the revisable window on its next pass, so recent days fill in on
-- their own and only history older than the revision window stays at 0.
ALTER TABLE "video_analytic"
  ADD COLUMN "averageViewPercent" DOUBLE PRECISION NOT NULL DEFAULT 0;
