-- What a scene is *for*, and which of its words carry weight.
--
-- Both belong to the single-insight short format (see
-- docs/superpowers/specs/2026-08-17-knowsense-format-design.md), where a script
-- is six named beats rather than prose, and the voice is told which words to
-- lean on.
--
-- "beat" is TEXT and not an enum on purpose. It is one format's vocabulary —
-- HOOK, TENSION, MECHANISM, NAME_IT, TURN, LOOP — and a second format with a
-- different structure should be a different set of strings, not a migration
-- that teaches the database about somebody else's story shape.
--
-- "emphasis" is an array beside the narration rather than markup inside it, so
-- the spoken text stays the plain text the aligner and the captions both read.
-- Marking up the narration would mean every consumer had to strip it, and the
-- one that forgot would either read the markup aloud or burn it on screen.
--
-- Both additive and both empty for every existing row: NULL beat and an empty
-- array mean "no format opinion", which is exactly what every scene rendered
-- before today had. Nothing is backfilled and no render changes.
ALTER TABLE "scene"
  ADD COLUMN "beat" TEXT,
  ADD COLUMN "emphasis" TEXT[] DEFAULT ARRAY[]::TEXT[];
