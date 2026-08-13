-- outputUrl held a Vercel Blob URL; it now holds a path relative to
-- RENDER_ROOT (see src/lib/render-storage.ts), or null for a render that
-- hasn't been copied onto this machine.
--
-- This statement is unconditional and needs no editing: it nulls every row
-- that still looks like a URL, regardless of whether scripts/migrate-renders.ts
-- copied that row's render. A null here already means "this needs
-- re-rendering" everywhere the app reads it, so nulling first and re-pointing
-- second (see below) is always safe to run, whatever Step 6.2 did or didn't
-- copy.
--
-- scripts/relink-renders.ts, run immediately after this migration (see
-- docs/vps-deployment.md's Step 6.4), re-points outputUrl back to a real path
-- for every row whose render is actually present at RENDER_ROOT right now —
-- by checking the filesystem, not by being told which rows to trust. That
-- means this file carries no video ids, needs no local edits before running,
-- and produces the same correct result whether zero, some, or all six
-- renders were copied.
UPDATE "render_job"
SET "outputUrl" = NULL
WHERE "outputUrl" LIKE 'https://%';
