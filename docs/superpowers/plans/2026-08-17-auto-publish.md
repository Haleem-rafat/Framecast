# Auto-Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A video made by an automation that is set to publish itself uploads to YouTube on its own, once it has finished rendering, without anybody opening the app.

**Architecture:** Two new columns on `Series` and `Schedule` say whether and how. A new `AutoPublishJob` row is written when the video is *created*, freezing the visibility of that moment. A fourth worker tick claims due jobs with the same conditional-update discipline `ReleaseService` already uses, calls the existing `PublishService.publish`, and separates three failure kinds — a spent quota (defer, not a fault), a refusal a retry cannot fix (fail now), and everything else (exponential backoff, then pause the parent at three).

**Tech Stack:** TypeScript, Next.js 15 App Router, Prisma 7 / Postgres, Vitest, Zod 4, react-hook-form, shadcn/Radix.

**Spec:** `docs/superpowers/specs/2026-08-17-automation-canvas-design.md` — Plan 1 only. Plan 2 (the React Flow canvas) is a separate plan written after this one lands.

## Global Constraints

- **Tests need a real Postgres, which the Mac does not have.** `pnpm test` fails locally. Run `pnpm lint` and `pnpm typecheck` locally; run the suite on the OVH VPS. See "Running the suite" below. Never claim tests pass without that output.
- **Every service test creates its own throwaway user** via `createTestUser` / `deleteTestUser` from `@/test/fixtures`. The test database is shared with real data; `prisma.user.findFirstOrThrow()` is forbidden.
- **`PublishService`, `ReleaseService` and the render pipeline are not modified**, except for one doc comment in Task 5 that this work makes false.
- **Auto-publish defaults to `false` and `PRIVATE`.** Both defaults are load-bearing — the failure mode of the other choice is a video on a real channel nobody chose to put there.
- **A one-off video from `/automation/generate` never gets a job.** It belongs to no automation, so there is no setting to read.
- **Comment style:** this codebase explains *why*, not *what*, and says plainly what it deliberately did not do. Match it. A comment that only restates the code is worse than none.
- **Three consecutive failures pause.** `MAX_ATTEMPTS = 3`, matching `MAX_CONSECUTIVE_FAILURES` in `schedule.service.ts` and `release.service.ts`.
- **Precedence:** a series-owned `Schedule`'s own `autoPublish`/`publishVisibility` are **ignored**; the `Series` row wins, exactly as `promptTemplateId` and `format` already do. Only a standalone schedule (`seriesId: null`) reads its own.

### Running the suite

```bash
rsync -az --delete -e "ssh -i ~/.ssh/framecast_vps" src/ root@51.38.80.36:/root/fc-src/src/
ssh framecast 'cd /srv/framecast
TEST_URL=$(grep -m1 "^DATABASE_URL=" env/prod.env | cut -d= -f2- | sed "s#/framecast\([?\"]\|$\)#/framecast_test\1#")
docker compose run --rm --no-deps -e DATABASE_URL="$TEST_URL" -e NODE_ENV=test \
  -v /root/fc-src/src:/app/src --entrypoint npx worker-prod vitest run'
```

Baseline before this plan: 38 files, 567 tests, all passing.

---

## File Structure

**Create:**
- `prisma/migrations/20260817120000_add_auto_publish/migration.sql` — the DDL
- `src/services/auto-publish.service.ts` — the queue: enqueue, claim, execute, tick
- `src/services/auto-publish.service.test.ts` — its tests

**Modify:**
- `prisma/schema.prisma` — `AutoPublishStatus` enum, `AutoPublishJob` model, four columns
- `src/services/automation.service.ts` — `AutomationOptions.autoPublish`, enqueue after create
- `src/services/schedule.service.ts` — `ScheduleClaim.autoPublish`, claim select, `runTopic`
- `src/services/publish.service.ts` — one sentence in `YouTubeQuotaError` (Task 5)
- `worker/index.ts` — the fourth tick
- `src/schemas/automation.schema.ts` — `autoPublish` / `publishVisibility` on series & schedule inputs
- `src/services/series.service.ts` and `src/services/schedule.service.ts` — accept the two fields on create/update
- `src/features/automation/components/series-form.tsx` — the switch
- `src/features/automation/components/schedule-form.tsx` — the switch

---

### Task 1: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260817120000_add_auto_publish/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `AutoPublishJob` model, `AutoPublishStatus` enum (`WAITING` | `CLAIMED` | `DONE` | `FAILED`), `Series.autoPublish: boolean`, `Series.publishVisibility: PublishVisibility`, `Schedule.autoPublish: boolean`, `Schedule.publishVisibility: PublishVisibility`, and `prisma.autoPublishJob` on the generated client.

- [ ] **Step 1: Add the enum to `prisma/schema.prisma`**

Put it beside the other automation enums (near `ScheduleStatus`, around line 1500):

```prisma
/// Where one auto-publish job is in its life.
///
/// `CLAIMED` is a lease rather than a state the operator cares about — it
/// exists so a second worker does not start an upload whose first attempt is
/// still in flight, and a claim whose lease has lapsed goes back to `WAITING`
/// without counting as a failure. A dead worker is not a failed publish.
enum AutoPublishStatus {
  WAITING
  CLAIMED
  DONE
  FAILED
}
```

- [ ] **Step 2: Add the model to `prisma/schema.prisma`**

Put it after `ScheduleRun` (after line 1694's `@@map("schedule_run")`):

```prisma
/// One row per video made by an automation that was set to publish itself.
///
/// A table rather than four more columns on `Video`, for three reasons. It
/// keeps scheduler bookkeeping — attempts, backoff, lease — out of a model that
/// is about a video rather than about a queue. It mirrors `RenderJob`, which is
/// the same shape for the same reason one stage earlier. And it gives a caller
/// a countable "waiting to publish" without scanning videos.
model AutoPublishJob {
  id String @id @default(uuid()) @db.Uuid

  /// `@unique`, and that is the backstop rather than the mechanism —
  /// `claimDue`'s conditional update is what prevents a double upload. This
  /// makes a second enqueue of the same video impossible even if a caller is
  /// written wrongly later.
  videoId String @unique @db.Uuid
  video   Video  @relation(fields: [videoId], references: [id], onDelete: Cascade)

  userId String @db.Uuid
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  /// Frozen at enqueue, which is the whole reason this row is written when the
  /// video is created rather than when it is ready. An operator may turn a
  /// series' auto-publish off, or move it from PUBLIC to PRIVATE, while three
  /// of its episodes are mid-render. Those three go out as what they were made
  /// under. Reading the series at publish time instead would let a setting
  /// changed on Tuesday silently rewrite what Monday's video does — a decision
  /// the operator never made, about a video they had stopped thinking about.
  visibility PublishVisibility

  status   AutoPublishStatus @default(WAITING)
  attempts Int               @default(0)

  /// Not before this. Moved forward by backoff after an ordinary failure, and
  /// to the next quota reset after a spent allowance.
  runAfter DateTime @default(now())

  /// Set while a worker holds this job, sized like `ReleaseService`'s because
  /// the work is the same work: one file off disk and one `videos.insert`.
  leaseExpiresAt DateTime?

  /// Why the last attempt failed, in a sentence safe to show verbatim.
  error String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  /// The claim query's index: due jobs, oldest first.
  @@index([status, runAfter])
  @@map("auto_publish_job")
}
```

- [ ] **Step 3: Add the back-relations and the four columns**

In `model Video`, beside the other back-relations, add:

```prisma
  autoPublishJob AutoPublishJob?
```

In `model User`, beside the other back-relations, add:

```prisma
  autoPublishJobs AutoPublishJob[]
```

In `model Series`, after `format`:

```prisma
  /// Whether an episode of this show uploads itself once it has rendered.
  ///
  /// Off by default, and that default is the important half: a show that
  /// publishes itself spends the operator's channel reputation without asking,
  /// and the failure mode of the other default is not a wasted render but a
  /// video on a real channel that nobody chose to put there.
  autoPublish       Boolean           @default(false)
  /// What an auto-published episode goes up as. PRIVATE for the same reason —
  /// the safe end of the range is the one you can walk back from.
  publishVisibility PublishVisibility @default(PRIVATE)
```

In `model Schedule`, after `variables`:

```prisma
  /// As `Series.autoPublish`, and read only for a **standalone** schedule.
  /// A series-owned schedule ignores both of these and reads the show's, the
  /// same precedence `promptTemplateId` and `format` already follow — a series
  /// is the thing the operator configures, and two places to set one fact is
  /// one place to set it wrongly.
  autoPublish       Boolean           @default(false)
  publishVisibility PublishVisibility @default(PRIVATE)
```

- [ ] **Step 4: Write the migration by hand**

`pnpm db:migrate` needs a database this machine cannot reach, so the SQL is written by hand and applied with `db:deploy` on the VPS — the same way `20260828090000_add_onboarding_progress` was done.

Create `prisma/migrations/20260817120000_add_auto_publish/migration.sql`:

```sql
-- Videos that publish themselves.
--
-- Until now the studio's most automated path stopped one step short of the only
-- step that matters: a series rendered an episode at 06:00 on Monday and then
-- waited for somebody to open the app and press a button. `ReleaseCadence` has
-- auto-published *shorts* since the release pack; this is the same idea for the
-- long videos those clips are cut from.
--
-- All four columns are additive with defaults, so there is no backfill and no
-- behaviour change for an existing row: every series and every schedule that
-- exists today comes out with `autoPublish = false`, which is exactly what they
-- do now.
ALTER TABLE "series"
  ADD COLUMN "autoPublish" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "publishVisibility" "PublishVisibility" NOT NULL DEFAULT 'PRIVATE';

ALTER TABLE "schedule"
  ADD COLUMN "autoPublish" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "publishVisibility" "PublishVisibility" NOT NULL DEFAULT 'PRIVATE';

CREATE TYPE "AutoPublishStatus" AS ENUM ('WAITING', 'CLAIMED', 'DONE', 'FAILED');

-- One row per video that was made by an automation set to publish itself. The
-- unique constraint on "videoId" is a backstop behind the claim's conditional
-- update, not the mechanism: it makes a second enqueue of the same video
-- impossible even if a caller is written wrongly later.
CREATE TABLE "auto_publish_job" (
  "id"             UUID NOT NULL,
  "videoId"        UUID NOT NULL,
  "userId"         UUID NOT NULL,
  "visibility"     "PublishVisibility" NOT NULL,
  "status"         "AutoPublishStatus" NOT NULL DEFAULT 'WAITING',
  "attempts"       INTEGER NOT NULL DEFAULT 0,
  "runAfter"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseExpiresAt" TIMESTAMP(3),
  "error"          TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "auto_publish_job_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "auto_publish_job_videoId_key" ON "auto_publish_job"("videoId");

-- The claim query scans exactly this: due jobs, oldest first.
CREATE INDEX "auto_publish_job_status_runAfter_idx" ON "auto_publish_job"("status", "runAfter");

ALTER TABLE "auto_publish_job"
  ADD CONSTRAINT "auto_publish_job_videoId_fkey"
  FOREIGN KEY ("videoId") REFERENCES "video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "auto_publish_job"
  ADD CONSTRAINT "auto_publish_job_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 5: Regenerate the client and verify it compiles**

Run: `pnpm db:generate && pnpm typecheck`
Expected: both succeed. `src/generated/prisma/models/AutoPublishJob.ts` now exists.

If `typecheck` complains that `"user"` or `"video"` is not the real table name, confirm against the `@@map` lines in `prisma/schema.prisma` and correct the SQL — the model names are `User` and `Video`, the tables are `user` and `video`.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260817120000_add_auto_publish src/generated
git commit -m "feat: give a series and a schedule the option to publish themselves

Four additive columns and a queue table. Nothing reads them yet.

The visibility lives on the job row rather than being looked up at publish
time, because an operator who turns auto-publish off on Tuesday has not
asked for Monday's already-rendered episode to change its mind."
```

---

### Task 2: `AutoPublishService.enqueue`

**Files:**
- Create: `src/services/auto-publish.service.ts`
- Create: `src/services/auto-publish.service.test.ts`

**Interfaces:**
- Consumes: `prisma` from `@/lib/prisma`; `PublishVisibility` from `@/generated/prisma/enums`.
- Produces:
  - `class AutoPublishService` with `constructor(publisher: Pick<PublishService, "publish"> = publishService)`
  - `async enqueue(userId: string, videoId: string, visibility: PublishVisibility): Promise<void>`
  - `export const autoPublishService: AutoPublishService`

- [ ] **Step 1: Write the failing test**

Create `src/services/auto-publish.service.test.ts`:

```ts
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { AutoPublishService } from "@/services/auto-publish.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

/**
 * The long-video drip, against a real Postgres.
 *
 * Same discipline as release.service.test.ts: a throwaway `User` per test,
 * because this database also holds the operator's real data. YouTube is never
 * called — the publisher is injected.
 */

let userId: string;

beforeEach(async () => {
  userId = await createTestUser("autopublish");
});

afterEach(async () => {
  await deleteTestUser(userId);
});

/** A video row with no project, which is all `enqueue` needs to key off. */
async function makeVideo(title = "Episode"): Promise<string> {
  const video = await prisma.video.create({
    data: { userId, title, status: "QUEUED" },
    select: { id: true },
  });
  return video.id;
}

describe("enqueue", () => {
  it("writes a waiting job carrying the visibility it was given", async () => {
    const service = new AutoPublishService({ publish: async () => {
      throw new Error("not called");
    } });
    const videoId = await makeVideo();

    await service.enqueue(userId, videoId, "PUBLIC");

    const job = await prisma.autoPublishJob.findUnique({ where: { videoId } });
    expect(job).not.toBeNull();
    expect(job?.status).toBe("WAITING");
    expect(job?.visibility).toBe("PUBLIC");
    expect(job?.attempts).toBe(0);
  });

  it("is idempotent — a second enqueue does not create a second job", async () => {
    const service = new AutoPublishService({ publish: async () => {
      throw new Error("not called");
    } });
    const videoId = await makeVideo();

    await service.enqueue(userId, videoId, "PUBLIC");
    await service.enqueue(userId, videoId, "PRIVATE");

    const jobs = await prisma.autoPublishJob.findMany({ where: { videoId } });
    expect(jobs).toHaveLength(1);
    // The first one wins. A retry of a create path must not silently rewrite
    // what the video was made under.
    expect(jobs[0].visibility).toBe("PUBLIC");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run the suite command from "Running the suite" above.
Expected: FAIL — `Cannot find module '@/services/auto-publish.service'`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/services/auto-publish.service.ts`:

```ts
import "server-only";

import type { PublishVisibility } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { publishService, type PublishService } from "@/services/publish.service";

/**
 * The long-video drip: a video that its automation said should publish itself.
 *
 * ## What this is, and what it deliberately is not
 *
 * `ReleaseService` is the same idea for shorts, and this file copies its
 * discipline rather than inventing a second one — see `claimDue`. What is
 * different is the trigger. A release fires on a *clock*: a slot comes round and
 * whatever is banked goes out. This fires on a *state*: a video that an
 * automation created reaches READY, and the job that was written when it was
 * created becomes due. There is no cadence here, because "publish it when it is
 * finished" has no time of day in it.
 *
 * Nothing in this file calls a model or spends provider money. The video it
 * uploads was already paid for.
 */

/** How long a worker holds a claimed job.
 *
 *  Five minutes, the same as `ReleaseService`'s and sized to the same work: one
 *  file read off local disk and one `videos.insert`. Long enough to outlast an
 *  honest upload on a domestic uplink, short enough that a dead worker's job is
 *  retaken on the next poll rather than stranded. */
const CLAIM_LEASE_SECONDS = 300;

export class AutoPublishService {
  /**
   * `Pick`, not the whole `PublishService`, for the reason `ReleaseService`
   * gives for the same choice: this service calls exactly one of its methods,
   * and typing the parameter as the full class would force every test to stub
   * the thumbnail path and the reclaims as well.
   */
  constructor(
    private readonly publisher: Pick<PublishService, "publish"> = publishService,
  ) {}

  /**
   * Books a video to publish itself once it is rendered.
   *
   * Called at *creation*, not at READY, which is what freezes the visibility —
   * see `AutoPublishJob.visibility`. The job simply is not due until the video
   * reaches READY; `claimDue` joins on that.
   *
   * `skipDuplicates` rather than a pre-check: the `videoId` unique constraint is
   * the real guard, and the only way a row already exists is a retried create
   * path, where re-booking is a no-op rather than an error worth surfacing.
   * Notably the FIRST booking wins — a retry must not rewrite what the video
   * was made under.
   */
  async enqueue(
    userId: string,
    videoId: string,
    visibility: PublishVisibility,
  ): Promise<void> {
    await prisma.autoPublishJob.createMany({
      data: [{ userId, videoId, visibility }],
      skipDuplicates: true,
    });
  }
}

export const autoPublishService = new AutoPublishService();
```

- [ ] **Step 4: Run the tests and watch them pass**

Run the suite command. Expected: both `enqueue` tests PASS.
Also run `pnpm lint && pnpm typecheck` locally. Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/auto-publish.service.ts src/services/auto-publish.service.test.ts
git commit -m "feat: book a video to publish itself when it is made

Booked at creation rather than at READY, so the visibility is the one the
video was made under. The first booking wins — a retried create path must
not rewrite it."
```

---

### Task 3: Enqueue from the automation paths

**Files:**
- Modify: `src/services/automation.service.ts` (`AutomationOptions`, and after `videoService.create` around line 452)
- Modify: `src/services/schedule.service.ts` (`ScheduleClaim` at line 217, the `claimDue` select, and `runTopic` around line 900)
- Modify: `src/services/auto-publish.service.test.ts`

**Interfaces:**
- Consumes: `AutoPublishService.enqueue` from Task 2.
- Produces: `AutomationOptions.autoPublish?: PublishVisibility` — present means "book it at this visibility", absent means no job. `ScheduleClaim.autoPublish: PublishVisibility | null`.

- [ ] **Step 1: Write the failing test**

Append to `src/services/auto-publish.service.test.ts`:

```ts
import { automationService } from "@/services/automation.service";

describe("the automation paths book a job", () => {
  it("books nothing when the options carry no autoPublish", async () => {
    // `/automation/generate` passes no options at all. A one-off video belongs
    // to no automation, so there is no setting to read and no default to invent.
    const videoId = await makeVideo();
    const jobs = await prisma.autoPublishJob.findMany({ where: { videoId } });
    expect(jobs).toHaveLength(0);
  });

  it("resolves a series-owned schedule's visibility from the series, not the schedule", async () => {
    // Precedence, asserted at the only place it is decided. A series is what
    // the operator configures; the schedule underneath it is an implementation
    // detail, and its own columns are dead data for this kind of row.
    const resolved = resolveAutoPublish(
      { autoPublish: true, publishVisibility: "PUBLIC" },
      { autoPublish: false, publishVisibility: "PRIVATE" },
    );
    expect(resolved).toBe("PUBLIC");
  });

  it("reads a standalone schedule's own visibility when there is no series", async () => {
    const resolved = resolveAutoPublish(null, {
      autoPublish: true,
      publishVisibility: "UNLISTED",
    });
    expect(resolved).toBe("UNLISTED");
  });

  it("returns null when the automation is switched off", async () => {
    const resolved = resolveAutoPublish(null, {
      autoPublish: false,
      publishVisibility: "PUBLIC",
    });
    expect(resolved).toBeNull();
  });
});
```

Add the import at the top of the test file:

```ts
import { resolveAutoPublish } from "@/services/schedule.service";
```

- [ ] **Step 2: Run it and watch it fail**

Run the suite command.
Expected: FAIL — `resolveAutoPublish` is not exported from `@/services/schedule.service`.

- [ ] **Step 3: Add the resolver and thread it through**

In `src/services/schedule.service.ts`, add near `recurrenceOf` (around line 238):

```ts
/** The two rows that can carry the setting, in the shape the precedence rule
 *  reads them in. */
interface AutoPublishSetting {
  autoPublish: boolean;
  publishVisibility: PublishVisibility;
}

/**
 * Which visibility a run's video should be booked to publish at, or null for
 * "do not book one".
 *
 * The series wins whenever there is one, the same precedence `promptTemplateId`
 * and `format` already follow through this file. A series is the thing the
 * operator configures; the schedule underneath it is an implementation detail
 * this app has spent real effort not leaking, and two places to set one fact is
 * one place to set it wrongly.
 *
 * Exported for its test. Nothing else outside this file calls it.
 */
export function resolveAutoPublish(
  series: AutoPublishSetting | null,
  schedule: AutoPublishSetting,
): PublishVisibility | null {
  const source = series ?? schedule;

  return source.autoPublish ? source.publishVisibility : null;
}
```

Add `PublishVisibility` to the type imports at the top of the file if it is not already there.

In `ScheduleClaim` (line 217), add:

```ts
  /**
   * What the produced video should publish itself as, or null for a schedule
   * that does not. Resolved in the same query that won the claim, for the same
   * reason `series` is: a run must not be configured from a row that changed
   * underneath it.
   */
  autoPublish: PublishVisibility | null;
```

Extend `ScheduleClaim.series` so the resolver can read it:

```ts
  series: {
    id: string;
    promptTemplateId: string;
    format: VideoFormat;
    autoPublish: boolean;
    publishVisibility: PublishVisibility;
  } | null;
```

In `claimDue`'s `findMany` select, add `autoPublish: true` and `publishVisibility: true` to both the top level and the nested `series` select. Where the claim object is built, set:

```ts
  autoPublish: resolveAutoPublish(candidate.series, candidate),
```

- [ ] **Step 4: Pass it to `AutomationService.start`**

In `src/services/automation.service.ts`, add to `AutomationOptions` (line 183):

```ts
  /**
   * Book the produced video to publish itself, at this visibility.
   *
   * Absent means no booking, which is every caller that existed before this and
   * is still what `/automation/generate` passes — a one-off video belongs to no
   * automation, so there is no setting to read and inventing a default would be
   * publishing something nobody asked to publish.
   */
  autoPublish?: PublishVisibility;
```

After `guardDuplicateSubmission` (around line 462), add:

```ts
    // Booked here rather than when the render finishes, so the visibility is
    // the one this video was made under — see `AutoPublishJob.visibility`. The
    // job is not *due* until the video reaches READY; `claimDue` joins on it.
    if (options.autoPublish) {
      await autoPublishService.enqueue(userId, video.id, options.autoPublish);
    }
```

Import `autoPublishService` at the top.

In `runTopic` (line 905), pass it through. The options object is currently built from `claim.series`; replace it with:

```ts
      const result = await this.automation.start(
        claim.userId,
        {
          projectId: claim.projectId,
          topic: topic.topic,
          variables: claim.variables,
        },
        {
          ...(claim.series
            ? {
                templateId: claim.series.promptTemplateId,
                format: claim.series.format,
                seriesId: claim.series.id,
              }
            : {}),
          // Spread separately from the series recipe because a *standalone*
          // schedule can carry it too — this is the one setting that is not the
          // show's alone.
          ...(claim.autoPublish ? { autoPublish: claim.autoPublish } : {}),
        },
      );
```

- [ ] **Step 5: Run the tests and watch them pass**

Run the suite command. Expected: the four new tests PASS and the existing `schedule.service.test.ts` still passes.
Run `pnpm lint && pnpm typecheck`. Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/services/automation.service.ts src/services/schedule.service.ts src/services/auto-publish.service.test.ts
git commit -m "feat: book the run's video when the automation says to publish itself

The series wins over the schedule underneath it, the same precedence the
script style and the format already follow — a series is what the operator
configures, and two places to set one fact is one place to set it wrongly.

/automation/generate still passes nothing. A one-off video belongs to no
automation, so there is no setting to read."
```

---

### Task 4: `claimDue` — winning exactly one job

**Files:**
- Modify: `src/services/auto-publish.service.ts`
- Modify: `src/services/auto-publish.service.test.ts`

**Interfaces:**
- Consumes: `enqueue` from Task 2.
- Produces:
  - `export interface AutoPublishClaim { jobId: string; userId: string; videoId: string; videoTitle: string; visibility: PublishVisibility; attempts: number }`
  - `async claimDue(now?: Date): Promise<AutoPublishClaim | null>`

- [ ] **Step 1: Write the failing test**

Append to `src/services/auto-publish.service.test.ts`:

```ts
/** A video that has finished rendering, which is the only kind a job is due for. */
async function makeReadyVideo(title = "Episode"): Promise<string> {
  const video = await prisma.video.create({
    data: { userId, title, status: "READY" },
    select: { id: true },
  });
  return video.id;
}

const noPublish = { publish: async () => { throw new Error("not called"); } };

describe("claimDue", () => {
  it("does not claim a job whose video has not rendered yet", async () => {
    // The whole reason booking early is safe. A job written when the video was
    // QUEUED simply is not due until the render finishes.
    const service = new AutoPublishService(noPublish);
    const videoId = await makeVideo();
    await service.enqueue(userId, videoId, "PUBLIC");

    expect(await service.claimDue()).toBeNull();
  });

  it("claims a job whose video is READY", async () => {
    const service = new AutoPublishService(noPublish);
    const videoId = await makeReadyVideo("Bedtime Stories 4");
    await service.enqueue(userId, videoId, "PUBLIC");

    const claim = await service.claimDue();

    expect(claim?.videoId).toBe(videoId);
    expect(claim?.videoTitle).toBe("Bedtime Stories 4");
    expect(claim?.visibility).toBe("PUBLIC");
  });

  it("cannot be claimed twice", async () => {
    // The property that matters most in this file: a second claim means the
    // same video uploaded to the same channel twice, and there is no way to
    // take either copy down from here.
    const service = new AutoPublishService(noPublish);
    const videoId = await makeReadyVideo();
    await service.enqueue(userId, videoId, "PUBLIC");

    const first = await service.claimDue();
    const second = await service.claimDue();

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("does not claim a job that is not due yet", async () => {
    const service = new AutoPublishService(noPublish);
    const videoId = await makeReadyVideo();
    await service.enqueue(userId, videoId, "PUBLIC");
    await prisma.autoPublishJob.update({
      where: { videoId },
      data: { runAfter: new Date(Date.now() + 60 * 60 * 1000) },
    });

    expect(await service.claimDue()).toBeNull();
  });

  it("retakes a claim whose lease has lapsed, without counting a failure", async () => {
    // A dead worker is not a failed publish. Nothing else would ever clear its
    // claim, which is why this is a lease and not a lock.
    const service = new AutoPublishService(noPublish);
    const videoId = await makeReadyVideo();
    await service.enqueue(userId, videoId, "PUBLIC");
    await prisma.autoPublishJob.update({
      where: { videoId },
      data: {
        status: "CLAIMED",
        leaseExpiresAt: new Date(Date.now() - 60_000),
      },
    });

    const claim = await service.claimDue();

    expect(claim?.videoId).toBe(videoId);
    expect(claim?.attempts).toBe(0);
  });

  it("does not touch a deleted video's job", async () => {
    const service = new AutoPublishService(noPublish);
    const videoId = await makeReadyVideo();
    await service.enqueue(userId, videoId, "PUBLIC");
    await prisma.video.update({
      where: { id: videoId },
      data: { deletedAt: new Date() },
    });

    expect(await service.claimDue()).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run the suite command.
Expected: FAIL — `service.claimDue is not a function`.

- [ ] **Step 3: Implement `claimDue`**

Add to `src/services/auto-publish.service.ts`:

```ts
/** How many due jobs one claim looks at.
 *
 *  Five, matching `ReleaseService`'s and `ScheduleService`'s, and for the same
 *  reason: the list exists only so a lost race falls through to another row
 *  instead of waiting for the next poll. */
const CANDIDATE_BATCH = 5;

/** A job won by `claimDue`, carrying everything `executeClaim` needs so it never
 *  re-reads a row another process may have moved underneath it. */
export interface AutoPublishClaim {
  jobId: string;
  userId: string;
  videoId: string;
  /** Read for the log line and the failure sentence, not for the upload — the
   *  title YouTube is told is `PublishService`'s business. */
  videoTitle: string;
  visibility: PublishVisibility;
  /** How many ordinary failures this job has already had. `executeClaim` needs
   *  it to decide between another backoff and giving up. */
  attempts: number;
}
```

And the method, inside the class:

```ts
  /**
   * Wins exactly one due job.
   *
   * ## Why this cannot publish twice
   *
   * The same shape as `ReleaseService.claimDue`, for the same reason: Prisma's
   * `updateMany` has no `LIMIT`, so an unconditional "claim the oldest due job"
   * would let two callers both match and both believe they won. Instead: read a
   * short list of candidates, then try to win each with an update whose `where`
   * repeats the exact state just read — here, `status: "WAITING"`. The
   * conditional update *is* the lock; the read above it is only a hint.
   *
   * The stake is higher here than almost anywhere else in this codebase. A lost
   * race that both callers won means the same video uploaded to the same channel
   * twice, and there is no unpublish path from this app.
   *
   * ## Why a booked job waits
   *
   * The `video` join is what makes booking-at-creation safe. A job written when
   * the video was QUEUED is not due until it is READY, so nothing has to
   * remember to enqueue later and nothing can publish a half-rendered file.
   */
  async claimDue(now: Date = new Date()): Promise<AutoPublishClaim | null> {
    const candidates = await prisma.autoPublishJob.findMany({
      where: {
        runAfter: { lte: now },
        video: { status: "READY", deletedAt: null },
        OR: [
          { status: "WAITING" },
          // A claim whose worker died. The lapsed case is why this is a lease
          // and not a lock: nothing else would ever clear it.
          { status: "CLAIMED", leaseExpiresAt: { lt: now } },
        ],
      },
      orderBy: { runAfter: "asc" },
      take: CANDIDATE_BATCH,
      select: {
        id: true,
        userId: true,
        videoId: true,
        visibility: true,
        attempts: true,
        status: true,
        video: { select: { title: true } },
      },
    });

    for (const candidate of candidates) {
      const { count } = await prisma.autoPublishJob.updateMany({
        where: {
          id: candidate.id,
          // The lock. Repeats the exact status just read, so only one caller can
          // still match. A lapsed CLAIMED row is retaken by the same expression
          // that read it.
          status: candidate.status,
          ...(candidate.status === "CLAIMED"
            ? { leaseExpiresAt: { lt: now } }
            : {}),
        },
        data: {
          status: "CLAIMED",
          leaseExpiresAt: new Date(now.getTime() + CLAIM_LEASE_SECONDS * 1000),
        },
      });

      // Another worker won it. Fall through to the next candidate rather than
      // waiting for the next poll.
      if (count === 0) continue;

      return {
        jobId: candidate.id,
        userId: candidate.userId,
        videoId: candidate.videoId,
        videoTitle: candidate.video.title,
        visibility: candidate.visibility,
        attempts: candidate.attempts,
      };
    }

    return null;
  }
```

- [ ] **Step 4: Run the tests and watch them pass**

Run the suite command. Expected: all six `claimDue` tests PASS.
Run `pnpm lint && pnpm typecheck`. Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/services/auto-publish.service.ts src/services/auto-publish.service.test.ts
git commit -m "feat: win exactly one due publish, and only once

The conditional update is the lock; the read above it is a hint. The stake
here is higher than most of this codebase — a lost race that both callers
won is the same video on the same channel twice, and there is no unpublish
path from this app.

A booked job waits on the video being READY, which is what makes booking it
at creation safe."
```

---

### Task 5: `executeClaim` — three kinds of failure

**Files:**
- Modify: `src/services/auto-publish.service.ts`
- Modify: `src/services/auto-publish.service.test.ts`
- Modify: `src/services/publish.service.ts` (one sentence, line 240)

**Interfaces:**
- Consumes: `AutoPublishClaim` from Task 4; `PublishService.publish`, `YouTubeQuotaError`, `hoursUntilQuotaReset` from `@/services/publish.service`; `ConflictError`, `NotFoundError` from `@/lib/errors`.
- Produces:
  - `export interface AutoPublishTickResult { jobId: string; videoId: string; videoTitle: string; outcome: "PUBLISHED" | "DEFERRED" | "FAILED"; youtubeVideoId: string | null; reason: string | null }`
  - `async executeClaim(claim: AutoPublishClaim, now?: Date): Promise<AutoPublishTickResult>`

- [ ] **Step 1: Write the failing test**

Append to `src/services/auto-publish.service.test.ts`. Add these imports at the top:

```ts
import { ConflictError } from "@/lib/errors";
import { YouTubeQuotaError } from "@/services/publish.service";
```

```ts
describe("executeClaim", () => {
  it("marks the job DONE when the upload succeeds", async () => {
    const service = new AutoPublishService({
      publish: async () => ({
        youtubeVideoId: "yt-123",
        shorts: [],
        thumbnail: { applied: true, error: null },
      }),
    } as never);
    const videoId = await makeReadyVideo();
    await service.enqueue(userId, videoId, "PUBLIC");
    const claim = await service.claimDue();

    const result = await service.executeClaim(claim!);

    expect(result.outcome).toBe("PUBLISHED");
    expect(result.youtubeVideoId).toBe("yt-123");
    const job = await prisma.autoPublishJob.findUnique({ where: { videoId } });
    expect(job?.status).toBe("DONE");
  });

  it("defers on a spent quota without counting a failure", async () => {
    // A quota ceiling is a fact about the day, not a fault in the automation.
    // Counting it would pause a healthy show for being third in the queue on a
    // busy Monday.
    const service = new AutoPublishService({
      publish: async () => {
        throw new YouTubeQuotaError("this episode");
      },
    } as never);
    const videoId = await makeReadyVideo();
    await service.enqueue(userId, videoId, "PUBLIC");
    const claim = await service.claimDue();

    const result = await service.executeClaim(claim!);

    expect(result.outcome).toBe("DEFERRED");
    const job = await prisma.autoPublishJob.findUnique({ where: { videoId } });
    expect(job?.status).toBe("WAITING");
    expect(job?.attempts).toBe(0);
    expect(job!.runAfter.getTime()).toBeGreaterThan(Date.now());
  });

  it("fails immediately on a refusal a retry cannot fix", async () => {
    // PublishService refuses a video whose project and series disagree about
    // the channel. Retrying that three times over ninety minutes helps nobody.
    const service = new AutoPublishService({
      publish: async () => {
        throw new ConflictError("This video is filed under a different channel.");
      },
    } as never);
    const videoId = await makeReadyVideo();
    await service.enqueue(userId, videoId, "PUBLIC");
    const claim = await service.claimDue();

    const result = await service.executeClaim(claim!);

    expect(result.outcome).toBe("FAILED");
    const job = await prisma.autoPublishJob.findUnique({ where: { videoId } });
    expect(job?.status).toBe("FAILED");
    expect(job?.error).toContain("different channel");
  });

  it("backs off an ordinary failure and keeps the job waiting", async () => {
    const service = new AutoPublishService({
      publish: async () => {
        throw new Error("socket hang up");
      },
    } as never);
    const videoId = await makeReadyVideo();
    await service.enqueue(userId, videoId, "PUBLIC");
    const claim = await service.claimDue();

    const result = await service.executeClaim(claim!);

    expect(result.outcome).toBe("DEFERRED");
    const job = await prisma.autoPublishJob.findUnique({ where: { videoId } });
    expect(job?.status).toBe("WAITING");
    expect(job?.attempts).toBe(1);
    expect(job?.error).toContain("socket hang up");
  });

  it("gives up on the third ordinary failure", async () => {
    const service = new AutoPublishService({
      publish: async () => {
        throw new Error("socket hang up");
      },
    } as never);
    const videoId = await makeReadyVideo();
    await service.enqueue(userId, videoId, "PUBLIC");
    await prisma.autoPublishJob.update({
      where: { videoId },
      data: { attempts: 2 },
    });
    const claim = await service.claimDue();

    const result = await service.executeClaim(claim!);

    expect(result.outcome).toBe("FAILED");
    const job = await prisma.autoPublishJob.findUnique({ where: { videoId } });
    expect(job?.status).toBe("FAILED");
    expect(job?.attempts).toBe(3);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run the suite command.
Expected: FAIL — `service.executeClaim is not a function`.

- [ ] **Step 3: Implement `executeClaim`**

Add to `src/services/auto-publish.service.ts`. New imports:

```ts
import { ConflictError, NotFoundError } from "@/lib/errors";
import {
  hoursUntilQuotaReset,
  publishService,
  YouTubeQuotaError,
  type PublishService,
} from "@/services/publish.service";
```

Constants:

```ts
/** How many ordinary failures give up on a job.
 *
 *  Three, the same as `MAX_CONSECUTIVE_FAILURES` in schedule.service.ts and
 *  release.service.ts. A repeated threshold rather than a shared constant,
 *  because they answer the same question about three different things and
 *  should be able to diverge without a rename. */
const MAX_ATTEMPTS = 3;

/** How long to wait after the Nth ordinary failure, in minutes.
 *
 *  Five, then thirty. The failures this covers are network hiccups and 5xxs
 *  from YouTube: the first retry wants to be soon enough that a blip costs
 *  nothing, and the second wants to be far enough out that a provider having a
 *  bad half-hour is not spent on. There is no third — `MAX_ATTEMPTS` ends it. */
const BACKOFF_MINUTES = [5, 30];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

The result type and the method:

```ts
export interface AutoPublishTickResult {
  jobId: string;
  videoId: string;
  videoTitle: string;
  /** `DEFERRED` covers both a spent quota and a backed-off failure. They are
   *  different in the *bookkeeping* — one counts an attempt and one does not —
   *  and identical in what happens next, which is "try again later". */
  outcome: "PUBLISHED" | "DEFERRED" | "FAILED";
  youtubeVideoId: string | null;
  reason: string | null;
}
```

```ts
  /**
   * Uploads one claimed video, and decides what its failure means.
   *
   * Three kinds, and separating them is most of the value of this method.
   *
   *   1. **A spent quota** is a fact about the day rather than a fault in the
   *      automation. The job waits for the reset, `attempts` is untouched, and
   *      nothing is paused. Counting it would stop a perfectly healthy show for
   *      the crime of being third in the queue on a busy Monday.
   *   2. **A refusal a retry cannot fix** — `PublishService` refusing a video
   *      whose project and series disagree about the channel, or a video it
   *      cannot find. Three attempts over ninety minutes would produce the same
   *      sentence three times. The job fails now, carrying that sentence, and
   *      the operator has something to act on.
   *   3. **Everything else** — a socket, a token refresh, a 5xx. Backoff, then
   *      give up at `MAX_ATTEMPTS`.
   *
   * The `Publication` row `PublishService` writes already carries the outcome,
   * the error and the thumbnail state. Nothing here duplicates it: this row
   * records only what the *queue* needs to know.
   */
  async executeClaim(
    claim: AutoPublishClaim,
    now: Date = new Date(),
  ): Promise<AutoPublishTickResult> {
    const base = {
      jobId: claim.jobId,
      videoId: claim.videoId,
      videoTitle: claim.videoTitle,
    };

    try {
      const result = await this.publisher.publish(claim.userId, claim.videoId, {
        visibility: claim.visibility,
      });

      await prisma.autoPublishJob.update({
        where: { id: claim.jobId },
        data: { status: "DONE", leaseExpiresAt: null, error: null },
      });

      return {
        ...base,
        outcome: "PUBLISHED",
        youtubeVideoId: result.youtubeVideoId,
        reason: null,
      };
    } catch (error) {
      const reason = messageOf(error);

      if (error instanceof YouTubeQuotaError) {
        await prisma.autoPublishJob.update({
          where: { id: claim.jobId },
          data: {
            status: "WAITING",
            leaseExpiresAt: null,
            // Not `attempts + 1`. See this method's doc comment.
            runAfter: new Date(
              now.getTime() + hoursUntilQuotaReset(now) * 60 * 60 * 1000,
            ),
            error: reason,
          },
        });

        return { ...base, outcome: "DEFERRED", youtubeVideoId: null, reason };
      }

      if (error instanceof ConflictError || error instanceof NotFoundError) {
        await prisma.autoPublishJob.update({
          where: { id: claim.jobId },
          data: { status: "FAILED", leaseExpiresAt: null, error: reason },
        });

        return { ...base, outcome: "FAILED", youtubeVideoId: null, reason };
      }

      const attempts = claim.attempts + 1;

      if (attempts >= MAX_ATTEMPTS) {
        await prisma.autoPublishJob.update({
          where: { id: claim.jobId },
          data: { status: "FAILED", attempts, leaseExpiresAt: null, error: reason },
        });

        return { ...base, outcome: "FAILED", youtubeVideoId: null, reason };
      }

      await prisma.autoPublishJob.update({
        where: { id: claim.jobId },
        data: {
          status: "WAITING",
          attempts,
          leaseExpiresAt: null,
          runAfter: new Date(
            now.getTime() + BACKOFF_MINUTES[attempts - 1] * 60 * 1000,
          ),
          error: reason,
        },
      });

      return { ...base, outcome: "DEFERRED", youtubeVideoId: null, reason };
    }
  }
```

- [ ] **Step 4: Correct the sentence this makes false**

`YouTubeQuotaError`'s message ends "Nothing retries automatically." That was true and is not any more. In `src/services/publish.service.ts` line 240, change:

```ts
        `at midnight Pacific Time — about ${hours} hour${hours === 1 ? "" : "s"} ` +
        `from now. A publish you started by hand is not retried; one an ` +
        `automation started waits for the reset and goes out by itself.`,
```

Check `publish.service.test.ts` for an assertion on the old wording and update it if there is one:
Run: `grep -rn "Nothing retries automatically" src/`

- [ ] **Step 5: Run the tests and watch them pass**

Run the suite command. Expected: all five `executeClaim` tests PASS, and `publish.service.test.ts` still passes.
Run `pnpm lint && pnpm typecheck`. Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/services/auto-publish.service.ts src/services/auto-publish.service.test.ts src/services/publish.service.ts
git commit -m "feat: tell a spent quota apart from a broken automation

Three failures, three answers. A quota ceiling is a fact about the day and
must not pause a healthy show. A channel mismatch will say the same thing
three times in ninety minutes, so it fails now with a sentence to act on.
Everything else backs off twice and then gives up.

YouTubeQuotaError no longer claims nothing retries automatically, because
now something does."
```

---

### Task 6: `tick`, pausing the parent, and the worker

**Files:**
- Modify: `src/services/auto-publish.service.ts`
- Modify: `src/services/auto-publish.service.test.ts`
- Modify: `worker/index.ts`
- Modify: `src/services/schedule.service.ts` (the `runTopic` doc comment, around line 890)

**Interfaces:**
- Consumes: `claimDue` and `executeClaim` from Tasks 4 and 5.
- Produces: `async tick(): Promise<AutoPublishTickResult | null>` — null means nothing was due.

- [ ] **Step 1: Write the failing test**

Append to `src/services/auto-publish.service.test.ts`:

```ts
describe("tick", () => {
  it("returns null when nothing is due", async () => {
    const service = new AutoPublishService(noPublish);
    expect(await service.tick()).toBeNull();
  });

  it("pauses the parent series' schedule when a job gives up", async () => {
    // A show whose episodes cannot publish must stop producing more of them.
    // The sentence is the one the operator reads on the automation list, so it
    // has to name what actually happened.
    const service = new AutoPublishService({
      publish: async () => {
        throw new ConflictError("This video is filed under a different channel.");
      },
    } as never);

    const channel = await prisma.channel.create({
      data: {
        userId,
        youtubeChannelId: `yt-${randomUUID()}`,
        title: "Kids",
        accessToken: "a",
        refreshToken: "r",
        tokenExpiresAt: new Date(Date.now() + 3_600_000),
        scopes: [],
      },
      select: { id: true },
    });
    const project = await prisma.project.create({
      data: { userId, name: "Kids", channelId: channel.id },
      select: { id: true },
    });
    const template = await prisma.promptTemplate.create({
      data: { userId, name: "t", content: "write about {{topic}}" },
      select: { id: true },
    });
    const series = await prisma.series.create({
      data: {
        userId,
        name: "Bedtime Stories",
        channelId: channel.id,
        projectId: project.id,
        promptTemplateId: template.id,
        autoPublish: true,
        publishVisibility: "PUBLIC",
      },
      select: { id: true },
    });
    const schedule = await prisma.schedule.create({
      data: {
        userId,
        name: "Bedtime Stories",
        projectId: project.id,
        seriesId: series.id,
        frequency: "WEEKLY",
        dayOfWeek: 1,
        hour: 6,
        minute: 0,
        timeZone: "Africa/Cairo",
        status: "ACTIVE",
      },
      select: { id: true },
    });
    const video = await prisma.video.create({
      data: { userId, title: "Ep 1", status: "READY", projectId: project.id, seriesId: series.id },
      select: { id: true },
    });
    await service.enqueue(userId, video.id, "PUBLIC");

    const result = await service.tick();

    expect(result?.outcome).toBe("FAILED");
    const paused = await prisma.schedule.findUnique({ where: { id: schedule.id } });
    expect(paused?.status).toBe("PAUSED");
    expect(paused?.pausedReason).toContain("different channel");
  });
});
```

Note: if `PromptTemplate` or `Series` require fields not listed above, read `prisma/schema.prisma` and add them — the test must construct valid rows, not minimal ones.

- [ ] **Step 2: Run it and watch it fail**

Run the suite command.
Expected: FAIL — `service.tick is not a function`.

- [ ] **Step 3: Implement `tick` and the pause**

Add to `src/services/auto-publish.service.ts`:

```ts
  /**
   * One due-check: claim at most one job and run it.
   *
   * At most one, which is also this app's answer to a worker coming back after
   * a day down with nine finished videos booked. They go out one poll apart
   * rather than nine at once onto a channel whose audience is asleep — the same
   * property `ReleaseService.tick` has, reached the same way.
   */
  async tick(): Promise<AutoPublishTickResult | null> {
    const claim = await this.claimDue();

    if (!claim) {
      return null;
    }

    const result = await this.executeClaim(claim);

    if (result.outcome === "FAILED") {
      await this.pauseParent(claim.videoId, result.reason);
    }

    return result;
  }

  /**
   * Stops the automation that made a video whose publish has given up.
   *
   * A show whose episodes cannot reach YouTube must stop producing more of
   * them: the alternative is a queue draining into a folder nobody is watching,
   * at full provider cost, until somebody notices.
   *
   * Two ways to find the automation, because the two kinds record their output
   * differently — a series tags its videos (`Video.seriesId`), a standalone
   * schedule does not and is reachable only through the run that produced this
   * video. Both land on the same `Schedule` row, which is where `status` and
   * `pausedReason` live for both kinds and what `describeHealth` already reads.
   *
   * Jobs already booked for this automation are deliberately left alone. A
   * video that is finished and was meant to go out should still go out once the
   * operator fixes whatever broke.
   */
  private async pauseParent(videoId: string, reason: string | null): Promise<void> {
    const video = await prisma.video.findUnique({
      where: { id: videoId },
      select: { seriesId: true },
    });

    const scheduleId = video?.seriesId
      ? (
          await prisma.schedule.findFirst({
            where: { seriesId: video.seriesId },
            select: { id: true },
          })
        )?.id
      : (
          await prisma.scheduleRun.findFirst({
            where: { videoId },
            orderBy: { createdAt: "desc" },
            select: { scheduleId: true },
          })
        )?.scheduleId;

    if (!scheduleId) return;

    await prisma.schedule.updateMany({
      where: { id: scheduleId, status: "ACTIVE" },
      data: {
        status: "PAUSED",
        pausedReason:
          `Paused because publishing an episode to YouTube failed and stopped ` +
          `retrying. The last attempt said: ${reason ?? "no reason was recorded"}`,
        nextRunAt: null,
      },
    });
  }
```

- [ ] **Step 4: Wire the worker**

In `worker/index.ts`, add the interval constant beside `RELEASE_TICK_INTERVAL_MS` (after line 51):

```ts
/**
 * How often to ask whether a finished video is booked to publish itself.
 *
 * The same thirty seconds as the schedule and release ticks. The latency that
 * matters here is measured against a weekly cadence — an episode going up
 * thirty seconds later than it could have is not a number anybody will notice —
 * and the query is the same single indexed lookup that almost always returns
 * nothing, so asking more often would buy nothing and cost round trips.
 */
const AUTO_PUBLISH_TICK_INTERVAL_MS = 30_000;
```

Add the import inside `main()` beside the others (after line 92):

```ts
  const { autoPublishService } = await import("@/services/auto-publish.service");
```

Add the timer beside `nextReleaseTickAt` (after line 297):

```ts
  /** When the auto-publish due-check may next run. Zero for the same reason as
   *  the other two: a worker that has just come back up is exactly when a
   *  finished video is most likely to have been waiting. */
  let nextAutoPublishTickAt = 0;
```

Add the tick immediately after the release tick block (after its closing brace around line 402), **before** the video claim:

```ts
      // Beside the release tick, ahead of the video claim, and for a different
      // reason from either of them. Those two sit here because they *create*
      // queued work. This one does not create anything — it finishes something.
      // What it shares is the failure mode of sitting behind the claim: on a
      // worker with a render backlog, an episode would go up whenever the
      // backlog happened to clear, which is the opposite of the promise
      // "publishes itself" makes.
      //
      // The cost when it fires is an upload — tens of megabytes to YouTube with
      // the loop held, seconds to tens of seconds. Identical to the release
      // tick's, and accepted for the identical reason: running it without
      // awaiting would put a multi-megabyte buffer beside whatever FFmpeg is
      // holding, on a box with 4GB and two vCPUs, at exactly the moment renders
      // are most likely to be running.
      if (Date.now() >= nextAutoPublishTickAt) {
        nextAutoPublishTickAt = Date.now() + AUTO_PUBLISH_TICK_INTERVAL_MS;

        const published = await autoPublishService.tick();

        if (published) {
          log(
            `auto-publish "${published.videoTitle}" → ${published.outcome}` +
              `${published.youtubeVideoId ? ` (youtube ${published.youtubeVideoId})` : ""}` +
              `${published.reason ? ` — ${published.reason}` : ""}`,
          );
        }
      }
```

- [ ] **Step 5: Correct the doc comment this makes false**

`runTopic`'s doc comment in `src/services/schedule.service.ts` (around line 890) says: *"Nothing in this file, and nothing in that method, creates a `Publication` or moves a video toward `PUBLISHED` — a scheduled run ends at a finished video waiting for the operator's own publish click, which is the property that makes unattended spending acceptable at all."*

That property has changed and the comment must say so. Replace that sentence with:

```
   * A scheduled run still ends at a finished video: nothing in this file
   * creates a `Publication`. What changed is what happens *after* it. An
   * automation with `autoPublish` set books the video at creation
   * (`AutomationOptions.autoPublish`), and `AutoPublishService` uploads it once
   * it is rendered. So unattended spending can now end in an unattended
   * publish — which is why that switch is off by default, defaults to PRIVATE,
   * and is the one setting on this path an operator has to turn on by hand.
```

- [ ] **Step 6: Run the tests and watch them pass**

Run the suite command. Expected: both `tick` tests PASS and the whole suite is green.
Run `pnpm lint && pnpm typecheck`. Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/services/auto-publish.service.ts src/services/auto-publish.service.test.ts worker/index.ts src/services/schedule.service.ts
git commit -m "feat: publish a finished episode from the worker, unattended

A fourth tick, thirty seconds, beside the release one and ahead of the video
claim — behind it, an episode would go up whenever the render backlog
happened to clear, which is the opposite of what 'publishes itself' promises.

One job per tick, so a worker back from a day down drips nine booked videos
out rather than firing them at a sleeping audience at once.

A show whose publishes have given up stops producing more. Its already-booked
videos are left alone: a finished video that was meant to go out should still
go out once the operator fixes what broke."
```

---

### Task 7: The switch in the forms

**Files:**
- Modify: `src/schemas/automation.schema.ts`
- Modify: `src/services/series.service.ts`
- Modify: `src/services/schedule.service.ts`
- Modify: `src/features/automation/components/series-form.tsx`
- Modify: `src/features/automation/components/schedule-form.tsx`

**Interfaces:**
- Consumes: the four columns from Task 1.
- Produces: `autoPublish: boolean` and `publishVisibility: PublishVisibility` on the create and update inputs for both kinds.

- [ ] **Step 1: Read the three files before changing them**

Run:
```bash
grep -n "autoPublish\|visibility" src/schemas/automation.schema.ts src/schemas/release.schema.ts
```
`release.schema.ts` already validates a `visibility` for the shorts cadence. Match its shape — same enum, same error messages — rather than inventing a second phrasing for the same field.

- [ ] **Step 2: Extend the schemas**

In `src/schemas/automation.schema.ts`, add to both the series and schedule create/update objects:

```ts
  autoPublish: z.boolean().default(false),
  publishVisibility: z
    .enum(["PRIVATE", "UNLISTED", "PUBLIC"])
    .default("PRIVATE"),
```

- [ ] **Step 3: Persist them**

In `SeriesService`'s create and update, and `ScheduleService`'s create and update, pass `autoPublish` and `publishVisibility` straight through to the Prisma `data`. They need no validation beyond the enum — there is no combination of the two that is invalid.

- [ ] **Step 4: Add the control to `series-form.tsx`**

Below the format field, add a switch and a visibility select revealed by it. Follow the file's existing `FormField` usage exactly:

```tsx
<FormField
  label="Publish each episode automatically"
  description="An episode uploads itself as soon as it has rendered, without anybody opening Framecast. Off means it waits in your videos list for you to publish it."
>
  <Switch
    checked={form.watch("autoPublish")}
    onCheckedChange={(checked) => form.setValue("autoPublish", checked)}
  />
</FormField>

{form.watch("autoPublish") && (
  <FormField
    label="Publish as"
    description="Private is the safe choice while you are getting a new show right — you can make a video public later, but you cannot unpublish one from here."
  >
    <Select
      value={form.watch("publishVisibility")}
      onValueChange={(value) => form.setValue("publishVisibility", value)}
    >
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="PRIVATE">Private</SelectItem>
        <SelectItem value="UNLISTED">Unlisted</SelectItem>
        <SelectItem value="PUBLIC">Public</SelectItem>
      </SelectContent>
    </Select>
  </FormField>
)}
```

Import `Switch` from `@/components/ui/switch`. If that component does not exist, run `pnpm dlx shadcn@latest add switch`.

- [ ] **Step 5: Add the same control to `schedule-form.tsx`**

Identical markup, with one wording change — a standalone schedule makes videos rather than episodes, so the label reads "Publish each video automatically" and the description says "A video uploads itself as soon as it has rendered".

Repeated rather than extracted into a shared component: the two forms have different surrounding layouts and this is nine lines of JSX. Extract it if a third caller appears.

- [ ] **Step 6: Verify by hand**

Run: `pnpm dev`, open `/automation/series/new`, and check that the visibility select appears only when the switch is on, that the form saves, and that reopening the series shows the saved values.

Run `pnpm lint && pnpm typecheck` and the suite command. Expected: clean and green.

- [ ] **Step 7: Commit**

```bash
git add src/schemas/automation.schema.ts src/services/series.service.ts src/services/schedule.service.ts src/features/automation/components/series-form.tsx src/features/automation/components/schedule-form.tsx
git commit -m "feat: let an operator turn auto-publish on, one show at a time

Off and PRIVATE by default in the form as well as the column, and the
visibility select only appears once the switch is on — a choice about how
public something is should not be sitting on screen for a show that is not
publishing itself at all."
```

---

## Self-Review

**Spec coverage.** Every Plan 1 section maps to a task: schema → 1; enqueue → 2 and 3; worker tick → 4, 5, 6; failure taxonomy → 5; pausing → 6; "where the setting is edited" → 7; testing → the test steps throughout. The spec's note that `automation-table.tsx` gains no column is honoured by no task touching it.

**Placeholders.** None. Every code step carries the code. The two places that say "read the file first" (Task 6 step 1's fixture fields, Task 7 step 1) are instructions to verify against the schema, not deferred decisions — the decision in both cases is already stated.

**Type consistency.** `AutoPublishClaim` is produced in Task 4 and consumed in Task 5 with the same six fields. `AutoPublishTickResult` is produced in Task 5 and returned unchanged by `tick` in Task 6. `resolveAutoPublish(series, schedule)` is defined and exported in Task 3 and imported by the test in the same task. `enqueue(userId, videoId, visibility)` is defined in Task 2 and called in Task 3 with that order.

**One thing the implementer must confirm rather than assume:** `PublishResult` in the Task 5 tests is stubbed as `{ youtubeVideoId, shorts, thumbnail }`. Read `PublishResult` in `src/services/publish.service.ts:395` and match the real shape — `ThumbnailOutcome`'s fields in particular are not guessed at anywhere in this plan.

---

## What this plan does not do

- The React Flow canvas. That is Plan 2, written after this lands.
- Any `published` count or `autoPublish` field on `AutomationEntry`. Plan 2 needs them; nothing here does.
- A retry-by-hand button for a `FAILED` job. The operator can still publish the video by hand from its page, which is the path that already exists.
- Backfilling jobs for videos that are already `READY`. Every existing series comes out with `autoPublish = false`, so there is nothing to backfill.
