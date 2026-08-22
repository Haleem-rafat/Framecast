-- The two things a daily cadence needs that the schedule could not express.
--
-- DAILY: ScheduleFrequency was WEEKLY | MONTHLY, so "every day" meant seven
-- weekly rows per channel — twenty-one across three channels, each with its own
-- ScheduleRun history, all needing to be paused together when something goes
-- wrong. dayOfWeek and dayOfMonth are already nullable and hour/minute/timeZone
-- already carry the time, so the value is the whole change on the data side;
-- nextOccurrence walks calendar days rather than adding 24 hours, which is what
-- keeps a 06:00 schedule at 06:00 through both DST boundaries.
--
-- autoShorts: the worker already encodes shorts that are QUEUED, but the step
-- that CREATES those rows — a model reading the script and picking the moments
-- worth clipping — is a button somebody presses. A daily cadence has nobody to
-- press it, and a release cadence with an empty queue publishes nothing and
-- says nothing about why. This fires on the same state auto-publish does: a
-- video an automation created reaching READY.
--
-- Off by default, because selection spends a model call and nothing should
-- start doing that because a column was added. Nullable is not needed — a
-- boolean with a default backfills every existing row to the behaviour it
-- already has.
--
-- Postgres permits ALTER TYPE ... ADD VALUE inside a transaction (PG 12+) as
-- long as the new value is not used in the same transaction; the ALTER TABLE
-- below adds a column and does not use it.
ALTER TYPE "ScheduleFrequency" ADD VALUE 'DAILY' BEFORE 'WEEKLY';

ALTER TABLE "schedule" ADD COLUMN "autoShorts" BOOLEAN NOT NULL DEFAULT false;
