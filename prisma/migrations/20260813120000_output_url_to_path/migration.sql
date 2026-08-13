-- outputUrl held a Vercel Blob URL; it now holds a path relative to
-- RENDER_ROOT (see src/lib/render-storage.ts).
--
-- Statement 1 rewrites ONLY the rows whose render is actually present at
-- RENDER_ROOT on this machine — the videoId list below, not every row that
-- merely looks like a Blob URL. scripts/migrate-renders.ts prints that exact
-- list (every videoId it copied, or found already copied) when it finishes;
-- paste it into the ARRAY[] below, replacing nothing else, immediately
-- before running `prisma migrate deploy`.
--
-- Do NOT commit that edit. The pasted values are real production video ids
-- and this repository is public — the same reason deploy/prod.env.example
-- stays a template and the filled-in prod.env never enters git (see
-- docs/vps-deployment.md). Running `prisma migrate deploy` only needs the
-- file on disk in the working directory it's invoked from; it does not need
-- to be committed, pushed, or reverted afterward — just left un-pushed.
--
-- As committed here, the list is empty. An empty PostgreSQL array literal
-- is valid SQL and matches zero rows by construction (`= ANY(ARRAY[]::...)`
-- is always false), not a syntax error and not "match everything" — so if
-- Step 6.2 (scripts/migrate-renders.ts) was skipped entirely, this file can
-- be run completely unedited: statement 1 touches nothing, and statement 2
-- (below) nulls every row that still looks like a Blob URL. That is also
-- the safe fallback if the list is edited incorrectly or left stale: worst
-- case, a render that really did copy is marked "needs re-rendering"
-- instead of pointing at its real path — recoverable, unlike the reverse.
UPDATE "render_job"
SET "outputUrl" = 'renders/' || "videoId" || '.mp4'
WHERE "outputUrl" LIKE 'https://%.blob.vercel-storage.com/%'
  AND "videoId" = ANY(ARRAY[
    -- Paste scripts/migrate-renders.ts's printed videoId list here, e.g.:
    -- '11111111-1111-1111-1111-111111111111',
    -- '22222222-2222-2222-2222-222222222222',
  ]::uuid[]);

-- Nulls every row statement 1 didn't touch — because its videoId wasn't in
-- the pasted list (render not copied, or Step 6.2 skipped entirely) — so no
-- row is ever left pointing at a Blob URL, or at a path that doesn't exist
-- on this box, once this migration has run. A null here already means "this
-- needs re-rendering" everywhere the app reads it; a path pointing at
-- nothing would surface as a broken player instead.
UPDATE "render_job"
SET "outputUrl" = NULL
WHERE "outputUrl" LIKE 'https://%';
