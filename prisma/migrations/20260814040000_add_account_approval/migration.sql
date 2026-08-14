-- Self-registration is gated: a new account is PENDING until an existing
-- operator approves it. See the AccountApproval enum's comment in schema.prisma
-- for why (framecasts.com is public, and every render spends the operator's own
-- API credits).
CREATE TYPE "AccountApproval" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "user"
  ADD COLUMN "approval" "AccountApproval" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "approvedAt" TIMESTAMP(3);

-- Every account that existed before this column did was created when accounts
-- were provisioned by hand, so all of them are already approved by definition.
-- Without this backfill the column default would leave every existing operator
-- PENDING and lock them out of their own studio on the next deploy.
UPDATE "user"
SET "approval" = 'APPROVED',
    "approvedAt" = "createdAt";

CREATE INDEX "user_approval_createdAt_idx" ON "user"("approval", "createdAt");
