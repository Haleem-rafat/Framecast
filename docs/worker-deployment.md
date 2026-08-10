# Deploying the render worker to Railway

The worker is the same repository as the app, deployed a second time with a different
entry point. It serves no HTTP and authenticates nobody: it polls the database for
claimable videos, runs the pipeline, and leaves finished videos at `READY` for Gate 2.

**Status: the image has never been built.** Docker is not installed on the development
machine, so `worker/Dockerfile` is written but unverified. Railway's first build is the
first real test of it. Expect to iterate once.

## 1. Create the service

Railway → New Project → Deploy from GitHub repo → select this repository.

`railway.json` already points the builder at `worker/Dockerfile`, so no build command
needs configuring.

## 2. Environment variables

The worker needs a strict subset of the app's configuration. Copy these from the Vercel
project's **production** environment (`vercel env pull` locally, or the Vercel dashboard):

| Variable | Why the worker needs it |
|---|---|
| `DATABASE_URL` | the queue and all pipeline state |
| `DIRECT_URL` | Prisma requires it alongside the pooled URL |
| `SUPABASE_CA_CERT` | Supabase signs Postgres with its own CA |
| `SUPABASE_URL` | narration audio, clips and captions |
| `SUPABASE_SERVICE_ROLE_KEY` | same |
| `SUPABASE_STORAGE_BUCKET` | same |
| `BLOB_READ_WRITE_TOKEN` | where the finished MP4 is written |
| `CREDENTIAL_ENCRYPTION_KEY` | decrypting the operator's ElevenLabs key |
| `PEXELS_API_KEY` | footage |
| `PIXABAY_API_KEY` | footage |
| `AI_GATEWAY_API_KEY` | not used by the worker today, but the service graph reads it |

`BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` **are** required, despite the worker serving
no HTTP and signing nobody in: `loadServerEnv` validates one schema for the whole
codebase, and the worker imports the service graph that reads it. Without them it exits at
boot on a validation error rather than running. The Google OAuth variables are genuinely
not needed.

Generate the whole block from a pulled environment rather than copying values by hand —
`.framecast/env/railway-dev.env` is produced that way and pastes directly into Railway's
**Variables → Raw Editor**. Railway's own "suggested variables" are scraped from source
and default `DATABASE_URL` to `localhost`, which fails immediately; do not accept them.

### The one that will bite you

**`CREDENTIAL_ENCRYPTION_KEY` must be byte-identical to production's.** It differs per
environment by design. A worker holding the wrong one decrypts nothing, and every render
fails at narration with an error that reads like a bad ElevenLabs API key rather than a
configuration mistake. If narration fails immediately on a worker that works locally,
check this first.

## 3. Keep it at one replica

`railway.json` pins `numReplicas: 1`. That is load-bearing, not a cost decision.

Leases are currently **advisory**: `JobService.heartbeat` and `release` are keyed on
`videoId` alone, with no `workerId` column to check ownership against. With one worker
that is harmless. With two, a worker whose lease has lapsed can renew a lease another
worker now holds, or release that worker's in-flight video. Add ownership checking before
raising the replica count.

## 4. Verifying the deploy

1. Railway logs should show the poll loop starting and reporting no claimable work.
2. In the app, press **Run** on a video whose script is approved.
3. The pipeline panel should move through narration → footage → captions → render without
   a terminal open anywhere.
4. Press **Cancel** mid-render: the worker kills FFmpeg on its next heartbeat (within 30
   seconds) and the video lands `FAILED` with a stated reason.
5. Press **Retry**: the video requeues and the worker reclaims it.

If a video fails three times it stops being claimable — that is `MAX_ATTEMPTS` protecting
against a deterministic failure spending money on every round. Retry from the app resets
the count.

## 5. What the worker deliberately will not do

It never publishes. Gate 2 is a human decision and stays in the app, on the operator's
own judgement, because an automated channel that publishes without review is the single
most demonetized configuration on YouTube.
