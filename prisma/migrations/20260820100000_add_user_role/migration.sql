-- Splits "may this account use the studio" from "may this account act on the
-- whole studio". See the UserRole comment in schema.prisma for the full story;
-- the short version is that `approval` was carrying both meanings, so with
-- registration open every approved account could approve or reject any other.
CREATE TYPE "UserRole" AS ENUM ('OPERATOR', 'MEMBER');

-- NOT NULL DEFAULT 'MEMBER', and deliberately NO backfill.
--
-- Every other enum column added to this schema was backfilled to preserve
-- existing behaviour (`approval` to APPROVED, `footageStyle` to LIVE_ACTION).
-- This one must not be, and the difference is the point: the behaviour being
-- preserved here would be the privilege escalation. There is no query this
-- migration could run that tells an operator from a member — the whole reason
-- the column exists is that the database has never recorded the difference —
-- so anything it guessed would grant 41 accounts the right to decide
-- registrations and read each other's data.
--
-- The owner's own account is therefore promoted afterwards, by hand:
--
--   pnpm tsx --conditions=react-server scripts/promote-operator.ts
--
-- Until that is run there are zero operators, /approvals and /admin are
-- reachable by nobody, and the queue simply waits. That is the correct failure
-- direction: an owner locked out of a queue for ten minutes is recoverable, 41
-- accounts silently holding each other's keys is not.
ALTER TABLE "user"
  ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'MEMBER';
