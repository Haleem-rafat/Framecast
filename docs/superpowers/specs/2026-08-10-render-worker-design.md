# Framecast — Render Worker

**Date:** 2026-08-10
**Status:** Approved for planning
**Scope:** Move the pipeline off the operator's Mac onto an always-on worker, so a video can be produced from a button in the app.

---

## 1. Goal

Today the pipeline runs via `pnpm render <videoId>` in a terminal on the operator's laptop.
It works — a real 1920×1080 MP4 with burned-in captions has been produced end to end — but:

- it requires a terminal
- it stops if the laptop sleeps
- nothing in the app can start, watch or stop it
- scheduling is impossible, and scheduling is the actual goal

**Done when:** the operator presses **Run** on `/videos/[id]`, closes the laptop, and comes
back to a finished video waiting at Gate 2.

### Not in scope

- Scheduling and cron — that is the next phase, and it needs this first
- Clips matched to narration content, thumbnails, Shorts
- Multiple concurrent workers — one is enough for 3 videos a week, and the lease design
  below does not preclude adding more later

---

## 2. Decisions

| Decision | Choice | Why |
|---|---|---|
| Host | **Railway**, ~$5/month | Docker-based so FFmpeg installs cleanly; simplest deploy; good logs |
| Scope | **Whole pipeline** | Narration, footage, captions, render in one job. One place to look when something fails |
| Job transport | **The database** | See §3 |
| Concurrency | **One worker** | Sufficient, and simpler to reason about |

### 2.1 A deliberate deviation from the original design

The first design sketch had the worker poll `GET /api/jobs/claim` over HTTP with a shared
secret, holding no database credentials.

**That is rejected here.** The worker now runs the *whole* pipeline, and every stage is
database-heavy — narration writes `VoiceOver` and `Asset` and `ProviderUsage`, footage
writes `Asset` rows, render writes `RenderJob` and `RenderLog`. Routing all of that through
HTTP would mean rebuilding six services as endpoints and maintaining two copies of the same
logic.

Instead the worker is **the same codebase deployed twice** — the Next.js app for the UI,
the worker for the pipeline — sharing `src/services/*` verbatim. It connects directly to
Postgres with its own credentials.

The trade this makes: the worker holds database credentials rather than only a shared
secret. That is acceptable because it is our own infrastructure on our own host, and the
alternative is a large duplicated surface that would drift. It would not be acceptable if
the worker were third-party or customer-run.

---

## 3. The queue is the database

No queue service. `Video.status = QUEUED` **is** the queue — videos sitting there are
exactly the work waiting to be done, which is already true today.

### 3.1 Claiming

A single atomic conditional update, the same shape Gate 1 and Gate 2 settled on after a
race was found in both:

```
UPDATE video
   SET status = 'GENERATING',
       leaseExpiresAt = now() + 10 minutes,
       attempts = attempts + 1
 WHERE status = 'QUEUED'
   AND (leaseExpiresAt IS NULL OR leaseExpiresAt < now())
   AND attempts < 3
 LIMIT 1
```

`count === 1` means the job is claimed. Two workers cannot claim the same video, because
only one update can match a `QUEUED` row.

### 3.2 Leases, not locks

The worker extends `leaseExpiresAt` every 30 seconds while working. If the worker dies —
crash, deploy, Railway restart — the lease expires and the video becomes claimable again.
A held lock would strand the job forever.

`attempts < 3` stops a video that fails deterministically from being retried until the end
of time, spending real money each round.

### 3.3 Cancelling

The app sets `Video.cancelRequestedAt`. The worker checks it on every heartbeat, and on
seeing it kills FFmpeg, marks the job `CANCELLED` and the video `FAILED` with a clear
reason.

Cancellation is cooperative rather than a signal, because the worker is the only thing that
knows what child process is running. A stage boundary is checked too, so cancelling during
narration or footage takes effect promptly rather than waiting for a render to start.

### 3.4 Schema changes

Three columns on `Video`. This is the only migration this project needs.

```prisma
/// Worker lease. Null when unclaimed; a past value means the holder died.
leaseExpiresAt    DateTime?
/// Guards against a deterministically-failing video retrying forever.
attempts          Int       @default(0)
/// Cooperative cancellation — the worker checks this on each heartbeat.
cancelRequestedAt DateTime?
```

---

## 4. Architecture

```
Vercel (Next.js)                     Railway (worker)
  UI, auth, gates                      Node + FFmpeg, Docker
  Run button → status = QUEUED         polls every 5s for a claimable video
  Cancel     → cancelRequestedAt        ↓
  panel polls pipeline state           narration → footage → captions → render
        ↓                                        ↓
        └──────── Supabase Postgres ─────────────┘
                  Supabase Storage
```

Both read and write the same database. The browser never talks to the worker; it watches
the database through the existing pipeline panel, which already polls every 2 seconds and
stops on a terminal state.

### 4.1 What the worker is

A small entry point — `worker/index.ts` — that loops:

1. Try to claim a video
2. If none, sleep 5 seconds
3. If claimed, start the heartbeat and run the stages the CLI already runs
4. On success, leave the video at `READY` for Gate 2
5. On failure, record the reason, release the lease, let `attempts` decide whether it retries

It **must not publish**. Gate 2 is a human decision and stays in the UI.

The existing `scripts/render.ts` and the worker share one orchestration function so the CLI
remains a debugging tool that runs the identical code path locally.

### 4.2 Docker

`node:24-slim` plus `ffmpeg` via apt. The image needs Prisma's generated client, so
`prisma generate` runs at build. No Next.js build — the worker imports services directly.

---

## 5. Configuration

The worker needs a subset of the app's environment:

| Variable | Why |
|---|---|
| `DATABASE_URL`, `DIRECT_URL` | the queue and all state |
| `SUPABASE_CA_CERT` | Supabase signs Postgres with its own CA |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` | audio, clips, MP4 |
| `CREDENTIAL_ENCRYPTION_KEY` | decrypting the operator's ElevenLabs key |
| `AI_GATEWAY_API_KEY` | not used by the worker today, but scripts may be regenerated later |
| `PEXELS_API_KEY`, `PIXABAY_API_KEY` | footage |
| `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID` | narration |

**`CREDENTIAL_ENCRYPTION_KEY` must be byte-identical to production's.** It differs per
environment by design; a worker with the wrong one decrypts nothing and every render fails
at narration with an error that looks like a bad API key rather than a config mistake.

`BETTER_AUTH_SECRET` and the Google OAuth variables are **not** needed — the worker serves
no HTTP and authenticates nobody.

---

## 6. What the operator gains

| | Today | With the worker |
|---|---|---|
| Start a render | terminal command | **Run** button |
| Laptop must stay awake | yes | no |
| Watch progress | panel, if the terminal is running | panel, always |
| Cancel | Ctrl-C in the terminal | **Cancel** button |
| Retry a failure | re-run the command | automatic, up to 3 attempts |
| Scheduling | impossible | unlocked — next phase |

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Worker dies mid-render | Lease expires; another attempt claims it |
| A video fails forever, spending money each time | `attempts < 3` |
| Two workers claim one video | Atomic conditional claim; only one update can match |
| Wrong `CREDENTIAL_ENCRYPTION_KEY` | Documented above; the worker should log a clear diagnostic when decryption fails rather than surfacing it as a provider error |
| Railway restarts during a deploy | Same as a crash — the lease covers it |
| Disk fills with temp files | Render already cleans up in a `finally`; the container is ephemeral anyway |
| Narration re-billed on retry | Existing guard: narration is skipped when a `VoiceOver` exists |

---

## 8. Task decomposition

| # | Task |
|---|---|
| 1 | Schema: `leaseExpiresAt`, `attempts`, `cancelRequestedAt` + migration |
| 2 | Claim, heartbeat and release, with a concurrency test proving two claimers get one video |
| 3 | Extract the shared orchestration so the CLI and worker run identical code |
| 4 | `worker/index.ts` — the loop, cancellation checks, graceful shutdown |
| 5 | Dockerfile + Railway deploy |
| 6 | **Run** and **Cancel** buttons, and surfacing attempts and lease state in the panel |

---

## 8.1 Known conflicts

**Finished renders are now local-only, and this worker design will need to be revisited
before it can ship.**

A real 7-minute render came in around 170MB — well past Supabase Storage's free-tier 50MB
object cap (uploads above it fail outright, they don't get resized down). Re-encoding to fit
50MB would mean ~930kbps at 1080p, visibly soft for content that gets published. The operator
chose instead to keep the finished MP4 on local disk (`.framecast/renders/`, see
`src/lib/local-render-storage.ts`) and drop it from the Supabase upload entirely. Narration,
clips and captions are unaffected — they're small and still go through Supabase Storage, which
this worker design's §5 configuration table already accounts for.

That fix directly conflicts with §4's architecture: **a file on the operator's Mac is
unreachable from a container running on Railway.** The worker can finish a render inside its
own container and have nothing reachable for Gate 2 preview or for `publish.service.ts` to
upload — both currently resolve the file from local disk on the same machine that rendered it,
an assumption that is simply false once rendering moves off that machine.

This is understood and accepted for now, not rediscovered later as a surprise. It does not
block Task decomposition items 1-5 (schema, claiming, orchestration extraction, the worker
loop, Docker/Railway deploy) — none of those depend on where the finished file ends up. It
does block treating the worker as done: Gate 2 preview and Gate 2 publish need a place to read
the finished video from that both the app (on Vercel) and the worker (on Railway) can reach.

The alternative considered and deferred, rather than building local disk storage in the first
place: **upload to YouTube as `private` immediately after rendering, and use YouTube's own
player for Gate 2 preview** instead of streaming the app's own copy of the bytes. The operator
reviews the private YouTube video directly; approving Gate 2 becomes flipping its visibility
from `private` to `unlisted` (a metadata call, not a second upload) rather than uploading for
the first time. This sidesteps the reachability problem entirely — YouTube is reachable from
both Vercel and Railway — at the cost of every render consuming a YouTube upload slot even for
videos the operator ultimately rejects at Gate 2, and losing the ability to preview a render
before any YouTube quota is spent on it. That tradeoff is why it was deferred rather than built
now: the operator is still watching most renders fail or need adjustment before Gate 2, and
today's local-disk player costs nothing per attempt. Revisit this once the worker is otherwise
ready to ship and this conflict is the one thing left blocking it.

## 9. What this deliberately does not solve

The worker makes production *possible* without a terminal. It does not make it
*automatic* — a human still presses Run, and still approves at Gate 2.

Scheduling is the next phase and needs two things this one provides: a machine that is
always on, and a queue that survives the browser being closed. Gate 2 stays human
regardless. An automated finance channel publishing without review is the single most
demonetized configuration on YouTube, and no amount of infrastructure changes that.
