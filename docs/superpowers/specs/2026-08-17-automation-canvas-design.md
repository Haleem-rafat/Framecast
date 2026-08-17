# Automation canvas and auto-publish

*2026-08-17*

## The complaint

Two of them, and they are the same complaint pointed at different ends of the
same pipeline.

**"The automation page is too much like a CRM."** `/automation` is one flat
`DataTable`. Three kinds — `SERIES`, `TOPIC_QUEUE`, `RELEASE_CADENCE` — are
flattened into rows sorted by health, then by next occurrence. That table was a
real improvement on the three screens it replaced, and it is still the wrong
shape for the question an operator actually asks. They do not ask "which of my
fourteen automations is unhealthy". They ask **"what is my kids channel doing"**,
and the answer to that is a shape: a channel, the shows on it, what each show
has banked, what it has made, what went out. A table can hold those numbers. It
cannot show that they hang off one another.

**"Videos should publish to YouTube by themselves."** They do not. `ReleaseCadence`
auto-publishes *shorts* on a timer and has since the release pack. A full video
still waits for a human to press a button — `publish-video-button.tsx` calling
`publish.action.ts`. So the automation makes a video at 06:00 on Monday, and
then it sits at `READY` until somebody opens the app. There is no `autoPublish`
flag anywhere in the schema. The most automated thing in the studio stops one
step short of the only step that matters.

## Two plans, deliberately

Plan 1 is auto-publish. Plan 2 is the canvas. They ship in that order and the
order is not arbitrary: Plan 1 is the one that changes what the product *does*,
and it is useful with the table exactly as it is today. Plan 2 changes how the
same facts are drawn. If Plan 2 is delayed, nothing about Plan 1 was wasted;
the reverse is not true, because a canvas whose publish node has nothing behind
it is a picture of a feature rather than a feature.

---

# Plan 1 — Auto-publish

## What already exists, and is not being rebuilt

`PublishService.publish(userId, videoId, { visibility, scheduledFor })` is the
upload path, and it is thorough: it refuses a publish whose project and series
disagree about the channel, it names both channels when it refuses, it handles
the thumbnail attaching separately from the video insert because they are
separate endpoints with separate quota costs, and it raises `YouTubeQuotaError`
as its own type. None of that is touched. Auto-publish is a *caller* of it.

`ReleaseService` is the model for the loop. It already drives an automated,
timer-based publish with the discipline that problem needs — a conditional
update whose `where` repeats the value just read, so a second worker cannot
claim the same slot; a lease sized to the work; three consecutive failures
pausing the cadence with a sentence a human can read. That discipline is
copied rather than reinvented, for the reason `ReleaseService`'s own comment
gives: a second pattern for the same problem is a second thing to get wrong.

## Schema

### The setting, on the two kinds that make videos

```prisma
model Series {
  /// Whether an episode of this show uploads itself once it renders.
  ///
  /// Off by default, and that default is the important half. A show that
  /// publishes itself is spending the operator's channel reputation without
  /// asking, and the failure mode of the wrong default here is not a wasted
  /// render — it is a video on a real channel that nobody chose to put there.
  autoPublish       Boolean           @default(false)
  /// What an auto-published episode goes up as. PRIVATE by default for the
  /// same reason as above: the safe end of the range is the one you can walk
  /// back from.
  publishVisibility PublishVisibility @default(PRIVATE)
}

model Schedule {
  autoPublish       Boolean           @default(false)
  publishVisibility PublishVisibility @default(PRIVATE)
}
```

`ReleaseCadence` gets neither. It already has `visibility` and it already
publishes by itself — that *is* what it is.

### The queue

```prisma
enum AutoPublishStatus {
  WAITING
  CLAIMED
  DONE
  FAILED
}

/// One row per video that was made by an automation set to publish itself.
///
/// A table rather than four more columns on `Video`, for three reasons. It
/// keeps scheduler bookkeeping — attempts, backoff, lease — out of a model
/// that is about a video rather than about a queue. It mirrors `RenderJob`,
/// which is the same shape for the same reason one stage earlier. And it gives
/// the canvas a number it can count without scanning videos: "3 waiting to
/// publish" is one indexed read.
model AutoPublishJob {
  id String @id @default(uuid()) @db.Uuid

  /// `@unique`, and that is the backstop rather than the mechanism. The claim
  /// below is what prevents a double upload; this makes a second enqueue of
  /// the same video impossible even if a caller is written wrongly later.
  videoId String @unique @db.Uuid
  video   Video  @relation(fields: [videoId], references: [id], onDelete: Cascade)

  userId String @db.Uuid
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  /// Frozen at enqueue, which is the whole point of this row existing early.
  /// The operator can turn a series' auto-publish off, or change it from
  /// PUBLIC to PRIVATE, while three of its episodes are mid-render. Those
  /// three go out as what they were made under. Reading the series at publish
  /// time instead would mean a setting changed on Tuesday silently rewriting
  /// what Monday's video does — a decision the operator never made about a
  /// video they had already stopped thinking about.
  visibility PublishVisibility

  status   AutoPublishStatus @default(WAITING)
  attempts Int               @default(0)

  /// Not before this. Moved forward by backoff after a failure, and by the
  /// quota window after a `YouTubeQuotaError`.
  runAfter DateTime @default(now())

  /// Set while a worker holds this job. Its narrow job is to stop a second
  /// worker starting a job whose upload is still in flight — the same reason
  /// `ReleaseService` has one, sized the same way, because the work is the
  /// same work: one file off disk and one `videos.insert`.
  leaseExpiresAt DateTime?

  /// Why the last attempt failed, in a sentence safe to show verbatim.
  error String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  /// The claim query's index: due jobs, oldest first.
  @@index([status, runAfter])
}
```

`Video` gains only the back-relation. No columns.

## Enqueue

`AutoPublishJob` rows are written at the moment the video is created, by the
two paths that create a video from an automation:

- `ScheduleService`, when an occurrence consumes a topic and starts a video.
- `AutomationService.start`, when a series' "Make one now" produces an episode —
  because an episode made by hand out of a show that publishes itself is still
  an episode of that show, and the operator would not expect one to behave
  differently from the other.

Neither path writes a job when the automation's `autoPublish` is false. A
one-off video from `/automation/generate` never gets one: it belongs to no
automation, so there is no setting to read, and inventing a default would be
publishing something nobody asked to publish.

## The worker tick

A fourth tick in `worker/index.ts`, beside the three that exist:

```
POLL           5s    videos to render
SCHEDULE      30s    occurrences due
RELEASE       30s    shorts slots due
ANALYTICS    120s    channel statistics
AUTO-PUBLISH  30s    ← new
```

Thirty seconds because it matches the two ticks it sits between, and because
the latency that matters here is measured against a weekly cadence — a video
going up thirty seconds later than it could have is not a number anybody will
ever notice.

### `AutoPublishService.claimDue()`

The claim is a conditional update, copied from `ReleaseService.claimDue`:

1. Read up to `CANDIDATE_BATCH` (5) jobs where `status = WAITING`,
   `runAfter <= now`, and the joined `video.status = READY` with
   `video.deletedAt = null`. The video-status join is what makes enqueue-early
   safe: a job written when the video was `QUEUED` simply is not due until the
   render finishes.
2. For each candidate in turn, attempt `updateMany` with a `where` that repeats
   `{ id, status: "WAITING" }` and sets `status: "CLAIMED"` plus
   `leaseExpiresAt: now + CLAIM_LEASE_SECONDS`. A count of 0 means another
   worker won; fall through to the next candidate rather than waiting for the
   next tick.
3. A `CLAIMED` job whose `leaseExpiresAt` has passed is reclaimable — its
   worker died. It goes back to `WAITING` with `attempts` untouched, because a
   dead worker is not a failed publish.

`CLAIM_LEASE_SECONDS = 300`, the same five minutes `ReleaseService` uses, and
for the reason it gives: comfortably longer than an honest upload on a domestic
uplink, short enough that a dead worker's job is retaken this poll rather than
next week.

### Executing a claim

`publishService.publish(userId, videoId, { visibility: job.visibility })`.

The result is a `Publication` row, which already carries `status`, `error`,
`publishedAt`, `thumbnailApplied` and `thumbnailError`. Nothing about the
outcome is recorded twice — the job row records only what the *queue* needs to
know, and points at the publication for everything else.

## Failure

Three outcomes, and separating them is most of the value of this section.

**`YouTubeQuotaError`.** `runAfter` moves to the next quota reset — midnight
US Pacific, which is when the Data API rolls its daily units, derived through
the same `wallClockToInstant` the scheduler uses so it survives DST rather than
drifting an hour twice a year. `attempts`
is **not** incremented and `consecutiveFailures` on the parent automation is
**not** touched. A quota ceiling is a fact about the day, not a fault in the
automation, and counting it would pause a perfectly healthy show for the crime
of being third in the queue on a busy Monday. This mirrors the distinction
`ReleaseService` already draws between a failure and an empty bank.

**A refusal that a retry cannot fix.** `publishService.publish` refuses a video
whose project and series disagree about the channel, and it refuses a scheduled
publish at a non-PUBLIC visibility. Retrying either is pointless. The job goes
straight to `FAILED` with the refusal's own sentence in `error`, and the parent
automation is paused with that same sentence — because the operator has to
change something before any future episode can go out either.

**Anything else** (network, token refresh, a 5xx from YouTube). `attempts++`,
`runAfter = now + backoff(attempts)` with exponential backoff, `error` recorded.
At `MAX_ATTEMPTS = 3` the job becomes `FAILED` and the parent automation's
`Schedule` is paused via the `pausedReason` column that already exists and that
`describeHealth` already renders. Three, matching every other consecutive-failure
threshold in this codebase.

A paused automation stops *producing*. Jobs already banked for it are left
alone — a video that is finished and was meant to go out should still go out
once the operator fixes whatever broke.

## Where the setting is edited (Plan 1)

The existing forms, because they exist and Plan 2 is not a prerequisite:

- `series-form.tsx` and `schedule-form.tsx` gain an auto-publish switch and,
  revealed by it, a visibility select.
- `automation-table.tsx` gains no column. The table is already wide, and the
  fact is better carried by the health language than by a fifteenth cell.

## Testing (Plan 1)

Vitest, matching the repo:

- `auto-publish.service.test.ts` — claim wins and loses; an expired lease is
  reclaimable without counting a failure; a quota error moves `runAfter` and
  leaves `attempts` alone; a permanent refusal skips backoff entirely; the
  third ordinary failure pauses the parent and no earlier one does; a job whose
  video is not yet `READY` is not due.
- `schedule.service.test.ts` / `automation.service.test.ts` — a job is enqueued
  when the automation says so and not when it does not, and the visibility on
  it is the automation's value at that instant.

---

# Plan 2 — The canvas

## What is being drawn

The tree is already in the schema. It is not being invented:

```
Channel
├── Project ─── Series ──── Schedule (cadence) ─── ScheduleTopic[] (backlog)
│                  └─────── Video[] ───────────── Publication[]
├── Project ─── Schedule (standalone topic queue)
└── ReleaseCadence (shorts drip)
```

Every edge above is a foreign key. That is the fact the design has to respect,
and it is stated here because it decides the next section.

## Free positions, honest handles

Positions are saved. That was chosen with the trade-off on the table: node
positions here carry no information, because the structure *is* the data, so
saving them buys arrangement rather than meaning and costs a table plus a
"something moved my node" question forever. The operator wants to arrange
their own canvas, and that is a legitimate thing to want.

What does **not** follow is free wiring. In n8n any output may reach any input.
Here `ReleaseCadence.channelId` is `@unique` per channel, a `Series` must agree
with its project's channel (`SeriesService.assertRecipe` enforces exactly this
and stays the only place that does), and a video belongs to whatever made it.
Connection handles that accept any drop would spend most of their drops on a
refusal dialog.

So: React Flow's `isValidConnection` decides, and every invalid target is
greyed out *while the wire is being dragged*. The affordance and the rule agree
at all times, which is the only version of this that does not teach the
operator to distrust the canvas.

| Drag from | Drop on | What is written |
|---|---|---|
| Channel | Series / Topic queue | Re-parent: `channelId` + `projectId`, through `assertRecipe` |
| Automation | Publish node | `autoPublish = true` on that automation |
| Channel | Shorts drip | Only when that channel has no `ReleaseCadence` |
| Channel handle | Empty canvas | Opens the new-automation menu at the drop point |

### Positions

```prisma
/// Where one node sits on this operator's canvas.
model CanvasNode {
  id String @id @default(uuid()) @db.Uuid

  userId String @db.Uuid
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  /// "channel:<id>", "series:<id>", "schedule:<id>", "release:<id>",
  /// "publish:series:<id>". A string rather than a foreign key, and the same
  /// choice `AutomationEntry.rowId` and `UserSetting.onboardingSeen` already
  /// make in this codebase: ids are unique only within a table, several kinds
  /// share this canvas, and a new kind should be a content change rather than
  /// a migration.
  ///
  /// The cost is that a deleted series leaves a row pointing at nothing. That
  /// is harmless — the canvas reads positions by looking *up* the keys it is
  /// drawing, never by listing this table — and they are cleared lazily on the
  /// next save rather than by a cascade this key cannot express.
  nodeKey String

  x Float
  y Float

  updatedAt DateTime @updatedAt

  @@unique([userId, nodeKey])
}
```

A node with no saved row is placed by `auto-place.ts` — a pure function, given
the tree and the boxes already taken, returning a free slot near its parent. It
is the whole of the "first load" experience and the whole of "you just made a
new series", so it is unit-tested rather than eyeballed.

## Reads

`automation-list.service.ts` is extended, not replaced. It already computes
`status`, `pausedReason`, `consecutiveFailures`, `cadence`, `timeZone`,
`nextRunAt`, `nextUp`, `backlog`, `produced`, `channel`, `channelWarning` and
`project` per automation, across all three kinds, with the sort and the health
language the canvas wants anyway. `AutomationEntry` gains two fields:

```ts
/// How many of `produced` actually reached YouTube. The number the operator
/// asked for — "made 34, published 30" is a different and more useful fact
/// than either half alone.
published: number;
/// Null when this kind cannot publish itself. Present and disabled is a
/// different state from absent, and the publish node has to draw both.
autoPublish: { enabled: boolean; visibility: PublishVisibility; waiting: number } | null;
```

A new `canvas.service.ts` groups those entries by channel and joins the saved
positions. It owns no rules — same read-only-projection discipline
`automation-list.service.ts` states for itself.

## Components

```
src/features/automation/canvas/
  automation-canvas.tsx      React Flow provider, controls, minimap
  nodes/channel-node.tsx     avatar, title, totals across its automations
  nodes/automation-node.tsx  state badge · cadence · backlog · made/published
  nodes/release-node.tsx     shorts drip · banked count
  nodes/publish-node.tsx     auto-publish on/off · visibility · waiting count
  node-inspector.tsx         right-hand panel; edits whatever is selected
  valid-connections.ts       the rules table above, as a pure function
  auto-place.ts              where an unpositioned node goes
  use-node-positions.ts      optimistic local move, debounced save
```

New dependencies: `@xyflow/react`. Nothing else — `motion` is already installed
and no layout engine is needed, because positions are the operator's.

## The table stays

`/automation` gets a Canvas ⇄ Table toggle, canvas first. Removing the table
would trade one complaint for another: a canvas shows shape, and a table is
still the better tool at forty automations when the question is "where is the
one called Bedtime Stories". The toggle's state is a new
`UserSetting.automationView` column (`CANVAS` | `TABLE`, defaulting to
`CANVAS`) rather than `localStorage`, for the third reason `onboardingSeen`
gives for the same choice: the dashboard layout already reads that row for
theme and accent, so the chosen view renders on the server and there is no
flash of the wrong one.

## Testing (Plan 2)

- `valid-connections.test.ts` — every row of the rules table, in both
  directions, including the `ReleaseCadence` uniqueness refusal.
- `auto-place.test.ts` — a node with no position lands free of its siblings;
  the same tree twice produces the same placement.
- `canvas.service.test.ts` — grouping by channel; an automation whose project
  has no channel; `published` counting publications rather than attempts.

React Flow rendering gets no component test. There is no testing-library in
`devDependencies` and this design does not add one for a canvas whose logic has
already been extracted into the two pure modules above.

## Explicitly out of scope

- Editing a video from the canvas. Nodes link to the pages that already exist.
- Free-form wiring between arbitrary nodes. See "Free positions, honest handles".
- Persisting zoom or pan. Positions are the operator's; the viewport is the
  session's.
- Any change to `PublishService`, `ReleaseService` or the render pipeline.
