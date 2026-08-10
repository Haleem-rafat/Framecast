# Render Worker — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the pipeline off the operator's laptop onto an always-on worker, so a video is produced by pressing **Run** in the app rather than typing a terminal command.

**Architecture:** No queue service — `Video.status = QUEUED` *is* the queue. A worker on Railway claims a video with a single atomic conditional update, holds a lease it renews every 30 seconds, runs the same services the CLI runs, and leaves the video at `READY` for Gate 2. The worker is the same codebase deployed twice, sharing `src/services/*` verbatim.

**Tech Stack:** Node 24, TypeScript, Prisma 7 + Supabase Postgres, Supabase Storage, FFmpeg, Docker, Railway.

## Global Constraints

- **Claiming, cancelling and every status transition use a single atomic conditional update** guarded on the current status, with the `VideoStatusEvent` appended in the same transaction. Gate 1 and Gate 2 both shipped with check-then-act races that were caught in review; do not reproduce that shape.
- **The worker must never publish.** Gate 2 is a human decision and stays in the UI.
- **Never re-synthesise existing narration.** The operator is on ElevenLabs' free tier — 10,000 characters a month, ~7,000 for one real script. The existing guard must survive into the worker path.
- **Service tests create their own throwaway `User`** via `src/test/fixtures.ts`. Never `prisma.user.findFirstOrThrow()` — that destroyed a real credential once.
- **Errors are typed** (`src/lib/errors.ts`); provider failures wrap in `ProviderError` with `retryable` from the status code.
- Comments explain *why*, not *what*.
- **Never run `pnpm build`** while the operator's dev server is running.
- Baseline at the start of this plan: **177 tests**, `pnpm typecheck` clean.

---

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `src/services/job.service.ts` | Claim, heartbeat, release, cancel |
| `src/services/pipeline-runner.ts` | The stage sequence, shared by CLI and worker |
| `worker/index.ts` | The loop, signal handling, graceful shutdown |
| `worker/Dockerfile` | Node + FFmpeg image |
| `railway.json` | Railway service config |

**Modify:** `prisma/schema.prisma` · `scripts/render.ts` · `src/services/pipeline.service.ts` · `src/actions/video.action.ts` · `src/features/videos/components/pipeline-panel.tsx` · `package.json`

---

### Task 1: Lease columns

**Files:**
- Modify: `prisma/schema.prisma`
- Create: a migration

**Interfaces:**
- Produces: `Video.leaseExpiresAt`, `Video.attempts`, `Video.cancelRequestedAt`

- [ ] **Step 1: Add three columns to `Video`**

```prisma
  /// Worker lease. Null when unclaimed; a value in the past means the holder
  /// died and the video is claimable again. A lock would strand it forever.
  leaseExpiresAt    DateTime?
  /// Guards a deterministically-failing video against retrying until the end of
  /// time, spending real provider money each round.
  attempts          Int       @default(0)
  /// Cooperative cancellation. The worker owns the FFmpeg child process, so
  /// only it can stop one; it checks this on every heartbeat.
  cancelRequestedAt DateTime?
```

Add an index supporting the claim query, which filters on status and lease:

```prisma
  @@index([status, leaseExpiresAt])
```

- [ ] **Step 2: Create and apply the migration**

Run: `pnpm db:migrate --name add_video_worker_lease`
Expected: migration created and applied. Confirm with `pnpm db:studio` or a query that the three columns exist and every existing row has `attempts = 0`.

- [ ] **Step 3: Regenerate the client and confirm nothing broke**

Run: `pnpm db:generate && pnpm typecheck && pnpm test`
Expected: 177 tests still passing.

⚠️ A stale generated client caused a `P2023` outage on the video page earlier in this project when an enum gained members. After any migration, regenerate **and restart the dev server**.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat: add worker lease columns to Video"
```

---

### Task 2: Claim, heartbeat, release

The heart of the worker. Everything else is orchestration around it.

**Files:**
- Create: `src/services/job.service.ts`, `src/services/job.service.test.ts`

**Interfaces:**
- Produces: `jobService.claimNext(workerId): Promise<{ videoId: string; userId: string } | null>`
- Produces: `jobService.heartbeat(videoId): Promise<{ cancelRequested: boolean }>`
- Produces: `jobService.release(videoId, outcome: "succeeded" | "failed" | "cancelled", reason?): Promise<void>`
- Produces: `jobService.requestCancel(userId, videoId): Promise<void>`

- [ ] **Step 1: Write the failing test**

The concurrency test is the point of this task. Gate 1's equivalent race reproduced in only 2 of 3 runs, so a single green run proves nothing — run it repeatedly.

```ts
import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { jobService } from "@/services/job.service";
// ... createTestUser from src/test/fixtures ...

describe("jobService.claimNext", () => {
  it("gives one video to exactly one of two concurrent claimers", async () => {
    const videoId = await queuedVideo();

    for (let run = 0; run < 10; run++) {
      await resetToQueued(videoId);

      const [a, b] = await Promise.all([
        jobService.claimNext("worker-a"),
        jobService.claimNext("worker-b"),
      ]);

      const claims = [a, b].filter((c) => c?.videoId === videoId);
      expect(claims).toHaveLength(1);
    }
  });

  it("returns null when nothing is queued", async () => { /* ... */ });

  it("reclaims a video whose lease has expired", async () => {
    // Simulates a worker that died mid-render: lease in the past, status
    // still GENERATING. Without this the video is stranded forever.
  });

  it("does not claim a video whose lease is still valid", async () => { /* ... */ });

  it("refuses a video that has already failed three times", async () => { /* ... */ });

  it("increments attempts on each claim", async () => { /* ... */ });
});

describe("jobService.heartbeat", () => {
  it("extends the lease", async () => { /* ... */ });

  it("reports a cancellation request", async () => { /* ... */ });
});

describe("jobService.release", () => {
  it("moves a succeeded video to READY and appends one event", async () => { /* ... */ });

  it("clears the lease so a failed video can be retried", async () => { /* ... */ });

  it("records the reason on failure", async () => { /* ... */ });
});
```

Write these out fully, following `src/services/video.service.test.ts` for fixture shape.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/services/job.service.test.ts`
Expected: FAIL — `Cannot find module '@/services/job.service'`

- [ ] **Step 3: Implement the claim**

Prisma's `updateMany` has no `LIMIT`, so claiming *one* video is two steps: pick a candidate, then win it with a conditional update. The conditional update is what makes it safe — a loser sees `count === 0` and tries the next candidate.

```ts
import "server-only";

import { prisma } from "@/lib/prisma";
import { NotFoundError } from "@/lib/errors";

/** How long a claim is held before another worker may take over. */
const LEASE_SECONDS = 600;
/** Renewal interval is far shorter, so a slow stage never loses its own lease. */
export const HEARTBEAT_SECONDS = 30;
/** A video that fails this many times stops costing money. */
const MAX_ATTEMPTS = 3;

export class JobService {
  async claimNext(
    workerId: string,
  ): Promise<{ videoId: string; userId: string } | null> {
    const now = new Date();

    // Candidates: queued and unclaimed, or claimed by a worker whose lease has
    // lapsed — that second case is a worker that died mid-run.
    const candidates = await prisma.video.findMany({
      where: {
        deletedAt: null,
        attempts: { lt: MAX_ATTEMPTS },
        cancelRequestedAt: null,
        OR: [
          { status: "QUEUED", OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] },
          { status: { in: ["GENERATING", "RENDERING"] }, leaseExpiresAt: { lt: now } },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: 5,
      select: { id: true, userId: true, status: true },
    });

    for (const candidate of candidates) {
      // The conditional update is the lock: only one caller can match a row in
      // this exact state, so only one can claim it.
      const { count } = await prisma.video.updateMany({
        where: {
          id: candidate.id,
          status: candidate.status,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
        },
        data: {
          status: "GENERATING",
          leaseExpiresAt: new Date(Date.now() + LEASE_SECONDS * 1000),
          attempts: { increment: 1 },
        },
      });

      if (count === 1) {
        await prisma.videoStatusEvent.create({
          data: {
            videoId: candidate.id,
            from: candidate.status,
            to: "GENERATING",
            message: `Claimed by ${workerId}`,
          },
        });

        return { videoId: candidate.id, userId: candidate.userId };
      }
    }

    return null;
  }

  /** Renews the lease and reports whether the operator asked to stop. */
  async heartbeat(videoId: string): Promise<{ cancelRequested: boolean }> {
    const video = await prisma.video.update({
      where: { id: videoId },
      data: { leaseExpiresAt: new Date(Date.now() + LEASE_SECONDS * 1000) },
      select: { cancelRequestedAt: true },
    });

    return { cancelRequested: video.cancelRequestedAt !== null };
  }
}

export const jobService = new JobService();
```

- [ ] **Step 4: Implement release and requestCancel**

`release` clears `leaseExpiresAt` in every case — a failed video must be claimable again, and a succeeded one must not look claimed. On success it transitions to `READY` with an atomic conditional update guarded on the current status. On failure it sets `FAILED` with `failureReason`. On cancellation it sets `FAILED` with a reason naming the operator, and clears `cancelRequestedAt` so the video can be retried later.

`requestCancel` is `userId`-scoped and only meaningful for a non-terminal video; refuse otherwise with `ConflictError`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test src/services/job.service.test.ts`
Expected: PASS. Report how many times the concurrency test ran.

- [ ] **Step 6: Commit**

```bash
git add src/services/job.service.ts src/services/job.service.test.ts
git commit -m "feat: claim, heartbeat and release videos for a worker"
```

---

### Task 3: Share the pipeline sequence

`scripts/render.ts` currently owns the stage order. The worker must run the identical sequence — two copies would drift, and the CLI is the debugging tool for the worker.

**Files:**
- Create: `src/services/pipeline-runner.ts`
- Modify: `scripts/render.ts`

**Interfaces:**
- Produces: `runPipeline(input: { userId, videoId, force?, onProgress?, shouldCancel? }): Promise<void>`

- [ ] **Step 1: Extract the sequence**

Move narration → footage → render out of `scripts/render.ts` into `runPipeline`. Keep the existing `onProgress` callback shape — the services already accept it and the CLI already prints from it.

Add a `shouldCancel?: () => boolean` the runner checks **between stages** and passes into the render service so a long FFmpeg run can be interrupted. The CLI passes nothing; the worker passes a check against its heartbeat.

- [ ] **Step 2: Rewrite the CLI to call it**

`scripts/render.ts` becomes argument parsing, environment loading, operator lookup, and printing. **Its behaviour must not change** — verify by running it against a finished video and confirming it still skips completed stages rather than redoing them.

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm test`, then `pnpm render <a finished videoId>` and confirm the output still reports every stage skipped and spends no ElevenLabs quota.

- [ ] **Step 4: Commit**

```bash
git add src/services/pipeline-runner.ts scripts/render.ts
git commit -m "refactor: share the pipeline sequence between CLI and worker"
```

---

### Task 4: The worker loop

**Files:**
- Create: `worker/index.ts`
- Modify: `package.json`

- [ ] **Step 1: Implement the loop**

```
loop:
  claim a video
  if none          → sleep 5s, continue
  start heartbeat every 30s
  run the pipeline, cancelling if a heartbeat reports cancelRequested
  release with the outcome
  stop the heartbeat
```

Requirements that are easy to miss:

- **Every iteration is wrapped in try/catch.** An unhandled throw must not kill the process — Railway would restart it, but the lease would then have to expire before the video is retried, wasting ten minutes.
- **The heartbeat must be stopped in a `finally`.** A leaked interval renews the lease of a job nobody is running, which is worse than no lease at all.
- **Handle `SIGTERM` gracefully.** Railway sends it on deploy. Stop claiming new work, let the current video finish if it can, and release its lease before exiting — otherwise the next deploy strands it for the full lease duration.
- **Log every claim, stage and release** to stdout. Railway's log view is the only window into this process.
- Read `WORKER_ID` from the environment, defaulting to the hostname, so logs identify which instance did what.

- [ ] **Step 2: Add the script**

```json
    "worker": "tsx --conditions=react-server worker/index.ts",
```

The `--conditions=react-server` flag matters: services import `server-only`, which throws under the default resolution. This is the same flag `scripts/render.ts` already needs.

- [ ] **Step 3: Verify locally against the real database**

Queue a video, run `pnpm worker`, and confirm it claims the video, runs the stages, and leaves it `READY`. Then:

- Kill the worker mid-render, confirm the lease expires and a restarted worker reclaims the video
- Request cancellation while it runs and confirm FFmpeg is killed and the video ends `FAILED` with a clear reason
- Send `SIGTERM` and confirm it exits cleanly rather than being killed

Paste all of this into your report. **Keep the test script short** — a few sentences — so a re-run costs a few hundred ElevenLabs characters rather than thousands.

- [ ] **Step 4: Commit**

```bash
git add worker/index.ts package.json
git commit -m "feat: add the render worker loop"
```

---

### Task 5: Docker and Railway

**Files:**
- Create: `worker/Dockerfile`, `railway.json`, `.dockerignore`

- [ ] **Step 1: Write the Dockerfile**

`node:24-slim`, then `apt-get install -y ffmpeg`. Copy the repo, `pnpm install --frozen-lockfile`, `pnpm prisma generate`, and run `pnpm worker`. **No Next.js build** — the worker imports services directly and never serves HTTP.

Add a `.dockerignore` excluding `.next`, `node_modules`, `.git`, `.superpowers` and `.env*`. An `.env` copied into an image is a leak that outlives the container.

- [ ] **Step 2: Verify the image locally**

Build it and run it against the dev database with the environment supplied on the command line. Confirm FFmpeg is present (`ffmpeg -version` inside the container) and that the worker claims and completes a video from inside Docker. This is where "works on my Mac" fails; find that out locally rather than on Railway.

- [ ] **Step 3: Deploy to Railway**

The operator creates the Railway account and project. Configure these environment variables:

```
DATABASE_URL  DIRECT_URL  SUPABASE_CA_CERT
SUPABASE_URL  SUPABASE_SERVICE_ROLE_KEY  SUPABASE_STORAGE_BUCKET
CREDENTIAL_ENCRYPTION_KEY
PEXELS_API_KEY  PIXABAY_API_KEY
ELEVENLABS_VOICE_ID  ELEVENLABS_MODEL_ID
WORKER_ID
```

⚠️ **`CREDENTIAL_ENCRYPTION_KEY` must be byte-identical to the one used by the database the worker points at.** It differs per environment by design. A mismatch means the worker decrypts nothing and every render fails at narration with an error that looks exactly like a bad ElevenLabs key. Verify by having the worker log a clear diagnostic when decryption fails, distinct from a provider error.

`BETTER_AUTH_SECRET` and the Google OAuth variables are **not** needed — the worker serves no HTTP and authenticates nobody. Do not copy them in.

- [ ] **Step 4: Confirm end to end**

Queue a video from the app, with no terminal open, and confirm the Railway worker picks it up and the video reaches `READY`. Paste the Railway logs.

- [ ] **Step 5: Commit**

```bash
git add worker/Dockerfile railway.json .dockerignore
git commit -m "feat: containerise the worker for Railway"
```

---

### Task 6: Run and Cancel in the app

**Files:**
- Modify: `src/actions/video.action.ts`, `src/features/videos/components/pipeline-panel.tsx`, `src/services/pipeline.service.ts`

- [ ] **Step 1: Add the actions**

`startPipelineAction(videoId)` — the video must be `DRAFT` with an approved script, or `FAILED` and retryable. It only sets `status = QUEUED` and clears `leaseExpiresAt`; the worker does the rest. Reset `attempts` to 0 on a deliberate retry, since the operator has presumably fixed whatever failed.

`cancelPipelineAction(videoId)` — calls `jobService.requestCancel`.

Both `userId`-scoped, both through `run()`.

- [ ] **Step 2: Surface them in the panel**

- **Run** when the video is approved and idle
- **Cancel** while a stage is active
- **Retry** when `FAILED` and `attempts < 3`
- When `attempts >= 3`, say so plainly and do not offer Retry — an operator clicking a button that silently does nothing is worse than a disabled one

Show `attempts` when above zero, and show that a video is waiting for a worker when queued but unclaimed. The panel already distinguishes active from idle for its polling interval; reuse that.

- [ ] **Step 3: Verify**

Press Run with the worker running and watch the panel move through the stages. Press Cancel mid-render and confirm it stops. Paste what you observed.

- [ ] **Step 4: Commit**

```bash
git add src/actions/video.action.ts src/features/videos/components/pipeline-panel.tsx src/services/pipeline.service.ts
git commit -m "feat: run, cancel and retry the pipeline from the app"
```

---

## Done when

- [ ] Pressing **Run** produces a video with no terminal open and the laptop closed
- [ ] Two concurrent claimers never take the same video, proven over repeated runs
- [ ] A worker killed mid-render loses its lease and the video is reclaimed
- [ ] **Cancel** stops an in-flight render and the video ends `FAILED` with a clear reason
- [ ] A video failing three times stops retrying and says so
- [ ] `SIGTERM` on deploy releases the lease rather than stranding the job
- [ ] Narration is never re-synthesised on a retry
- [ ] The worker never publishes — Gate 2 stays human
- [ ] `pnpm typecheck` and `pnpm test` pass
