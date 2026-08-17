-- Which pieces of onboarding an operator has already read and put away.
--
-- The old product tour kept one boolean in `localStorage`, and that was a
-- defensible trade while it *was* one boolean. Onboarding now covers the whole
-- studio — a first-run tour, a setup checklist, and a hint that appears once
-- per screen — so the thing being remembered is a growing set, and the cost of
-- remembering it per browser is that every new device re-teaches an operator
-- everything they already know.
--
-- Text array rather than a column per hint: adding a screen hint should be a
-- content change, not a migration.
--
-- Purely additive with a default, so no backfill and no behaviour change for an
-- existing row. Note what an empty array means for the ~existing operators who
-- already dismissed the old tour in their browser: they will be offered it once
-- more, because the flag it was stored under was never visible to Postgres.
-- Showing a five-step tour a second time to a handful of accounts is the
-- cheaper end of the two errors available here.
ALTER TABLE "user_setting"
  ADD COLUMN "onboardingSeen" TEXT[] DEFAULT ARRAY[]::TEXT[];
