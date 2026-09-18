-- A short's opening card and how its last line was asked to land.
--
-- Both nullable with no backfill. A script written before this migration has
-- neither, and renders exactly as it did: the card is drawn only when this
-- column holds one, and nothing reads the ending kind except a later
-- comparison of the two kinds, which has no history to compare anyway.
CREATE TYPE "EndingKind" AS ENUM ('LOOP', 'DEBATE');

ALTER TABLE "script_version"
  ADD COLUMN "hookCard" TEXT,
  ADD COLUMN "endingKind" "EndingKind";
