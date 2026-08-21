-- A fifth footage style, and the first whose cadence is a property of its
-- script rather than of the renderer.
--
-- ILLUSTRATED and CINEMATIC both generate their pictures and both let
-- planStoryBeats group sections into stills held 15-25 seconds — a band
-- measured on four-minute bedtime stories and documented in lib/story-beats.ts.
-- The doodle genre cuts every five to twenty seconds instead, and the way it
-- gets there is not a new grouping rule. planStoryBeats already cuts one
-- picture per cue when every cue carries a shot tag; the doodle script format
-- tags every section, so the writer's section count IS the picture count. That
-- is why this migration adds a column that no rendering code reads.
--
-- beatSeconds is where the operator's choice is stored, and script.service.ts
-- is the only thing that ever reads it — it turns the number into a requested
-- section count in a system instruction, and from that point on the cadence
-- travels inside ScriptVersion.cues, which footage, render and shorts already
-- all read. Passing it to planStoryBeats instead would put three separate
-- fetches behind a function whose whole premise is that no stored plan can
-- drift from the script.
--
-- Adding a value rather than replacing one, exactly as CINEMATIC and MIXED
-- were added. Every existing brand row keeps what it has, LIVE_ACTION stays the
-- column default, beatSeconds is NULL everywhere and needs no backfill, and no
-- channel's output changes until an operator picks the new option. Postgres
-- permits ALTER TYPE ... ADD VALUE inside a transaction (PG 12+) as long as the
-- new value is not *used* in the same transaction; the ALTER TABLE below adds a
-- column and does not use it.
ALTER TYPE "FootageStyle" ADD VALUE 'DOODLE';

ALTER TABLE "channel_brand" ADD COLUMN "beatSeconds" INTEGER;
