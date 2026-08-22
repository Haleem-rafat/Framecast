-- Who stopped an automation, recorded rather than guessed.
--
-- The automation canvas inferred the actor from whether pausedReason was set:
-- empty meant "the operator paused by hand without comment", present meant one
-- of the self-pause paths, which all write a sentence. That held right up until
-- something paused an automation deliberately AND said why — which setting up
-- the daily cadence did six times, so six automations a human had just paused
-- all reported "Stopped on its own".
--
-- An inference that is only correct while nobody writes a helpful message is a
-- coincidence rather than a signal.
--
-- Defaults to false, so every existing row keeps the meaning it had. The label
-- reads reasonless-and-false as an operator pause for exactly that reason:
-- rows written before this column used the absence of a reason to say so, and
-- backfilling them to true would claim knowledge this migration does not have.
-- Only reason-present-and-false is a self-pause.
ALTER TABLE "schedule" ADD COLUMN "pausedByOperator" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "release_cadence" ADD COLUMN "pausedByOperator" BOOLEAN NOT NULL DEFAULT false;
