-- outputUrl held a Vercel Blob URL; it now holds a path relative to
-- RENDER_ROOT (see src/lib/render-storage.ts). Rows whose render was copied
-- across (scripts/migrate-renders.ts) are rewritten to that path. Rows whose
-- render was not copied are nulled: the file does not exist on the new
-- machine, and a path pointing at nothing would surface as a broken player
-- rather than as the honest "this needs re-rendering" that a null already
-- produces everywhere it is read.
--
-- Table and column names verified directly against prisma/schema.prisma's
-- RenderJob model: `@@map("render_job")`, with `outputUrl` and `videoId`
-- carrying no field-level `@map`, so their column names are unchanged from
-- the Prisma field names. Confirm this still holds with `\d render_job` in
-- psql before running, in case the schema has moved since this migration was
-- written.
--
-- Run the second statement only if scripts/migrate-renders.ts was skipped or
-- only partially completed — e.g. the Blob store was never un-suspended, or
-- the run stopped partway through. Rows the first statement already rewrote
-- no longer match either WHERE clause, so running both in order is always
-- safe and only ever touches the rows still pointing at Blob.
UPDATE "render_job"
SET "outputUrl" = 'renders/' || "videoId" || '.mp4'
WHERE "outputUrl" LIKE 'https://%.blob.vercel-storage.com/%';

UPDATE "render_job"
SET "outputUrl" = NULL
WHERE "outputUrl" LIKE 'https://%';
