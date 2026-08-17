-- The automation canvas: node positions, and which view an operator prefers.
--
-- /automation was one flat table with three kinds of automation sorted by
-- health. That answers "which automation is unhealthy" and not "what is my kids
-- channel doing" — and the answer to the second is a shape rather than a row.
--
-- Positions are stored because the operator asked to arrange their own canvas.
-- They carry no information: the structure is already in the foreign keys
-- between channel, project, series and schedule. So nothing downstream depends
-- on a row existing — a node with no position is placed by `autoPlace` instead,
-- and no read anywhere fails because one is missing.
--
-- Dated 20260830 to sort after 20260829_add_auto_publish. Prisma applies
-- migrations in lexicographic order of folder name, and this repo's migration
-- dates run ahead of the calendar; a migration stamped with today's real date
-- would file itself in the middle of applied history. See the git history of
-- 20260829090000_add_auto_publish, which was renamed for exactly that.
CREATE TYPE "AutomationView" AS ENUM ('CANVAS', 'TABLE');

-- Additive with a default, so no backfill: every existing operator opens on the
-- canvas, which is the point of building it.
ALTER TABLE "user_setting"
  ADD COLUMN "automationView" "AutomationView" NOT NULL DEFAULT 'CANVAS';

CREATE TABLE "canvas_node" (
  "id"        UUID NOT NULL,
  "userId"    UUID NOT NULL,
  -- "series:<uuid>", "channel:<uuid>", "publish:series:<uuid>", ... A string
  -- rather than a foreign key: five kinds of thing share this canvas and their
  -- ids are unique only within their own tables. A row naming something that
  -- has since been deleted is harmless and swept lazily.
  "nodeKey"   TEXT NOT NULL,
  "x"         DOUBLE PRECISION NOT NULL,
  "y"         DOUBLE PRECISION NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "canvas_node_pkey" PRIMARY KEY ("id")
);

-- One position per node per operator, which is also what makes the upsert in
-- `CanvasService.moveNode` a single statement.
CREATE UNIQUE INDEX "canvas_node_userId_nodeKey_key" ON "canvas_node"("userId", "nodeKey");

ALTER TABLE "canvas_node"
  ADD CONSTRAINT "canvas_node_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
