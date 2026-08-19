# Framecast

An automated video studio for YouTube. You give it a topic; it writes the
script, narrates it, collects or generates the footage, renders the video,
writes the metadata, draws the thumbnail, cuts vertical shorts out of it, and
uploads the lot to a connected channel — on demand, or on a schedule, without
anyone at the keyboard.

Everything below is what the code actually does today, not a roadmap.

---

## Contents

- [How a video gets made](#how-a-video-gets-made)
- [The two gates](#the-two-gates)
- [Formats and footage styles](#formats-and-footage-styles)
- [Shorts](#shorts)
- [Automation](#automation)
- [Publishing and analytics](#publishing-and-analytics)
- [Screens](#screens)
- [Accounts, roles and approval](#accounts-roles-and-approval)
- [Stack](#stack)
- [Architecture](#architecture)
- [The three processes](#the-three-processes)
- [Data model](#data-model)
- [Providers and credentials](#providers-and-credentials)
- [Getting started](#getting-started)
- [Environment](#environment)
- [Scripts](#scripts)
- [Testing](#testing)
- [Conventions](#conventions)
- [Deployment](#deployment)
- [Repo map](#repo-map)

---

## How a video gets made

The pipeline is defined in exactly one place — `src/services/pipeline-runner.ts`
— and both callers (the render worker and the debugging CLI) run that same
sequence, so neither can drift from the other.

| Stage | What happens | Who it calls |
| --- | --- | --- |
| **script** | A prompt template plus your topic goes to a model, which returns narration split into sections, each with a b-roll cue (or six named story beats, for the single-insight format). Every generation is stored as a new `ScriptVersion` — nothing is overwritten. | AI Gateway (`AI_SCRIPT_MODEL`) |
| **bucket** | Ensures the video's object prefix exists under `STORAGE_ROOT`. | local disk |
| **narration** | The approved script is synthesised to speech *with timestamps*, and those timestamps become the caption file. Re-synthesis is guarded: it costs real quota, so it only happens when the narration is genuinely stale, never on an ordinary retry. | ElevenLabs |
| **footage** | Per section, either stock clips are searched and downloaded, or stills are generated and given a Ken Burns move. A music bed is fetched if a key is configured. | Pexels / Pixabay / image model / Jamendo |
| **render** | FFmpeg assembles clips + narration + music + burned-in captions into one MP4. Progress and elapsed time are streamed back so the UI can show a live bar; a long encode can be cancelled mid-run, not just at a stage boundary. | FFmpeg |
| **metadata** | Title, description and tags are written from the script. | AI Gateway |
| **thumbnail** | An image is generated from the script's hook, then FFmpeg composites a short headline onto it at 1280x720 and encodes it under YouTube's file-size cap. Stored as a `ThumbnailVersion`. | image model + FFmpeg |
| **upload** | The finished file, its metadata and its thumbnail go to the channel. | YouTube Data API |

`metadata` and `thumbnail` deliberately swallow their own errors: neither is
allowed to fail a video that has already rendered. The pipeline panel shows
them as `skipped` rather than `failed`, because "it ran and produced nothing"
and "this video predates the feature" are indistinguishable after the fact and
guessing between them would be worse than not distinguishing them.

Video status moves `DRAFT → QUEUED → GENERATING → RENDERING → READY →
PUBLISHED`, with `FAILED` reachable from the middle. Every transition is
appended to `VideoStatusEvent`; nothing is edited in place.

Work is claimed with a **lease**. A worker takes a queued video, holds a lease
it renews on a heartbeat, and a lease that lapses is reclaimed and retried up
to `MAX_ATTEMPTS`. That is safe for renders (a re-run costs CPU only) and is
deliberately *not* how publishing behaves — see below.

## The two gates

Two points in the flow need a human, and the code names them:

- **Gate 1 — script approval.** No narration is synthesised until the script is
  approved, because narration is the first stage that spends real money. The
  guided automation flows *do* cross this gate for you, and say so on screen.
- **Gate 2 — publishing.** A rendered video sits at `READY` and goes no further.
  Nothing uploads to a real channel unless you press the button, or unless you
  explicitly switched auto-publish on for that automation. A publish also holds
  a lease, but a lapsed publish lease is never auto-retried: the process may
  have died with the video already live, and a second upload would put a second
  copy on your channel with no way to take either back. The stuck row is handed
  to the operator to clear instead.

## Formats and footage styles

**Format** (`VideoFormat`): `LANDSCAPE` (1920x1080) or `VERTICAL` (1080x1920).
Vertical is composed natively at that aspect ratio, never cropped out of a
landscape render.

**Footage style** (`FootageStyle`) decides where pictures come from:

| Style | Source | Notes |
| --- | --- | --- |
| `LIVE_ACTION` | Pexels + Pixabay, unfiltered | The original behaviour. |
| `CARTOON` | Pixabay with `video_type=animation`, safesearch on | Never Pexels. |
| `ILLUSTRATED` | Generated stills, one per story beat | Every image is conditioned on the channel's character sheet, so the same character appears in scene 1 and scene 40. Needs branding set up first. |
| `CINEMATIC` | Generated photographic stills, one per shot | Holds the grade and the lens constant, not the character — the subject is the viewer, so a recurring face would break a second-person script. Needs nothing pre-generated. |

Generated stills are held 15–25 seconds each under the renderer's pan, which is
why a still-based channel is affordable where per-scene video generation is not.

## Shorts

A short is not cut out of the finished render. It is **re-composed from the
section clips the render itself played**, at 1080x1920, using the same
`composer.ts` the full render uses.

That is a bug fix, not a tidy-up: the assemble pass burns landscape captions
into the render's pixels, so a 9:16 crop of it arrived with two sets of
subtitles and the first set could not be turned off — it was the image.

Two halves that never run at once:

1. **Generate** — a model reads the script section by section and picks the
   moments worth clipping. Each pick becomes a `QUEUED` `Short` row. No
   encoding, so the click returns in one model call's time.
2. **Encode** — the worker claims one queued short at a time and encodes it.

Nothing in the shorts path writes to `Video`, so a short that fails to select,
encode or store leaves its parent `READY` and publishable exactly as it was.

## Automation

Five distinct things, each with its own service, all visible on one canvas:

- **One-click video** (`automation.service.ts`) — one form: topic, a little
  direction, a length. It owns no domain logic; it performs the existing
  create → generate → approve sequence without the navigation between screens.
- **Easy mode** (`easy-mode.service.ts`) — the same flow with two taps and no
  typing: pick a channel, pick a subject, everything else is answered from data
  that already exists. It cannot produce a video the long form couldn't.
- **Series** (`series.service.ts`) — one named recurring show. Niche, tone,
  voice, music, footage style, art style and character live on the series
  instead of being re-chosen across five screens each time.
- **Schedules** (`schedule.service.ts`) — the one-click flow on a timer, with a
  `ScheduleRun` record of every time it fired and what came of it. Explicitly
  *not* a drag-and-drop graph builder: there is one possible flow shape, so the
  useful part was the timer and the audit trail, not the canvas.
- **Release cadence** (`release.service.ts`) — the shorts drip. Three shorts a
  day is not twenty-one fresh videos a week; it is a **release queue with a
  timer on it**, spending clips already produced and paid for. Nothing in it
  calls a model.
- **Auto-publish** (`auto-publish.service.ts`) — fires on a *state* rather than
  a clock: a video an automation created reaches `READY` and uploads itself.
  Off by default.

The **automation canvas** (`/automation`) is a read-only projection over all of
these, grouped by channel, ordered so the branch needing the most attention
comes first. Node positions are the only thing it stores.

## Publishing and analytics

Channels connect over YouTube OAuth (`/api/youtube/connect` → `/api/youtube/callback`).
Publishing uploads the render, sets visibility, applies the thumbnail and
records a `Publication` (or `ShortPublication`). After a successful publish the
local render file is reclaimed — on a 40GB box that cleanup is what keeps the
disk from filling.

`ChannelStatistic` and `VideoAnalytic` collect subscribers, views and watch
time per channel on a slow worker tick. Both are append-only histories.

## Screens

| Route | What it is |
| --- | --- |
| `/dashboard` | Today's state at a glance. |
| `/analytics` | Subscribers, views, watch time per channel. |
| `/logs` | Activity log. |
| `/projects` | Grouping of videos. |
| `/videos`, `/videos/[id]` | The library, and one video's pipeline panel, script, versions, shorts and publish controls. |
| `/channels`, `/channels/[id]` | Connected channels, branding, logo, character sheet. |
| `/automation` | The canvas — every series, schedule and cadence, by channel. |
| `/automation/generate` | One-click / easy mode. |
| `/automation/series`, `/schedules`, `/releases` | Create and edit each automation kind. |
| `/studio/script`, `/studio/voice`, `/studio/thumbnail` | Per-stage studios. |
| `/publishing` | Publish queue and history. |
| `/prompts` | Prompt library with typed variables. |
| `/providers` | Your API keys, encrypted at rest, each testable. |
| `/approvals` | Registration queue. **Operator only.** |
| `/admin`, `/admin/users/[id]` | Every account's data. **Operator only.** |
| `/settings` | Theme, accent, preferences. |
| `/`, `/contact`, `/privacy`, `/terms` | Public marketing pages. |

`src/config/navigation.ts` is the single source for the sidebar, the ⌘K command
palette and breadcrumbs. Adding a route there wires it into all three.

## Accounts, roles and approval

Sign-up is open, but an account is useless until it is approved:

- Every new account takes the `PENDING` default on the `approval` column and is
  redirected to `/pending`. The gate reads the column directly, not the session
  copy, and fails closed.
- An account whose email is `SEED_USER_EMAIL` or listed in `AUTH_ALLOWED_EMAILS`
  is approved at creation — otherwise a fresh database would have an approval
  queue nobody could ever empty.
- That grants **approval only, never the role**. Deciding other people's
  registrations requires `OPERATOR`, which is granted out-of-band:
  `pnpm promote:operator <email>`. A sign-up body carrying `"role": "OPERATOR"`
  cannot reach Postgres — the field isn't declared to the auth adapter, so the
  column's `MEMBER` default wins.
- Every table is scoped by `userId` and every query filters on it. A `MEMBER`
  sees only their own rows.

There is no email transport in this repo. Password reset writes the link to the
activity log and says so out loud (`PASSWORD_RESET_DELIVERY=log`).

## Stack

| Layer | Choice |
| --- | --- |
| Frontend | Next.js 15 (App Router), React 19, Tailwind v4, shadcn/ui |
| State | TanStack Query (server state), Zustand (client state) |
| Backend | Server Actions + Route Handlers, service classes |
| Data | PostgreSQL 17, Prisma 7 (`prisma-client` + `@prisma/adapter-pg`) |
| Auth | Better Auth (email/password + Google, Prisma adapter) |
| AI | Vercel AI SDK v7 through the AI Gateway |
| Storage | Local disk (`STORAGE_ROOT` for objects, `RENDER_ROOT` for renders) |
| Video | FFmpeg |
| Canvas | React Flow (`@xyflow/react`) |
| Tests | Vitest against a real Postgres |
| Deploy | Docker Compose + Caddy on a single VPS |

## Architecture

Layering is strict and one-directional — the UI never reaches past the service
layer:

```
app/          route composition, auth gating, Suspense boundaries
features/     feature-scoped components + types (videos, automation, studio, …)
components/   ui/ (shadcn), layout/ (shell), shared/ (cross-feature primitives)
services/     business logic + all data access. The only layer touching Prisma.
server/       server-only concerns (session, approval gate)
actions/      server actions — thin; validate, call a service, revalidate
schemas/      Zod contracts, shared by forms and server boundaries
lib/          prisma, auth, storage, ffmpeg argv builders, typed errors, cn()
config/       env validation, navigation
```

Key invariants:

- **Providers are never called from the UI.** Service classes own every
  outbound API call.
- **`config/env.ts` is server-only** and fails fast at import if a variable is
  missing or malformed.
- **Errors are typed** (`lib/errors.ts`). Non-`AppError` throws collapse to a
  generic internal error, so driver messages never reach the browser.
- **Secrets are encrypted at rest** with `CREDENTIAL_ENCRYPTION_KEY`; reads use
  an explicit select list, so `encryptedKey` is absent by construction rather
  than by remembering to omit it.
- **Soft delete** via `deletedAt`; every read filters it out.
- **Append-only history**: `VideoStatusEvent`, `ScriptVersion`,
  `ThumbnailVersion`, `ChannelStatistic`, `VideoAnalytic`, `ScheduleRun` and
  `ReleaseRun` are never updated in place.
- **FFmpeg argv lives in `lib/ffmpeg-command.ts` / `lib/thumbnail-command.ts`**
  as pure, tested functions — the services spawn, they don't build strings.
- **Process spawning and `fetch` are injectable** in every service that uses
  them, so no test ever runs FFmpeg or calls a real API.

## The three processes

| Process | Command | What it does |
| --- | --- | --- |
| **Web app** | `pnpm dev` / `pnpm start` | The whole UI. Serves renders and narration by byte range through route handlers. |
| **Render worker** | `pnpm worker` | No HTTP, no auth. Polls every 5s for a queued video or short and runs the pipeline; ticks schedules, shorts releases and auto-publish jobs every 30s; collects channel analytics on a much slower timer. Identifies itself as `WORKER_ID` in status events. |
| **Render CLI** | `pnpm render` | The debugging path. Calls the identical `runPipeline`, printing every stage event — useful precisely *because* it is not a second implementation. |

The worker and the CLI both load `.env.local` then `.env`, and import
everything dynamically inside `main()` — a static import of anything touching
`@/config/env` would read `process.env` before dotenv had run.

## Data model

37 migrations, ~50 models. Grouped:

- **Auth** — `User` (with `role`, `approval`), `Session`, `Account`, `Verification`
- **Channels** — `Channel`, `ChannelBrand`, `ChannelCollection`, `ChannelStatistic`
- **Content** — `Project`, `Video`, `VideoStatusEvent`, `Script`, `ScriptVersion`,
  `Scene`, `Asset`, `VoiceOver`, `Thumbnail`, `ThumbnailVersion`
- **Rendering** — `RenderJob`, `RenderLog`, `Short`
- **Publishing** — `Publication`, `ShortPublication`, `VideoAnalytic`
- **Automation** — `Series`, `Schedule`, `ScheduleTopic`, `ScheduleRun`,
  `ReleaseCadence`, `ReleaseRun`, `AutoPublishJob`, `CanvasNode`
- **Config** — `PromptTemplate`, `PromptVariable`, `ProviderCredential`,
  `ProviderUsage`, `UserSetting`, `ActivityLog`

Enums carry doc comments explaining *why* each variant exists — `FootageStyle`
and `UserRole` in particular are worth reading before changing either.

## Providers and credentials

Two different kinds of key, on purpose:

- **Per-operator**, stored encrypted in `ProviderCredential` and managed on
  `/providers`: ElevenLabs, Anthropic/OpenAI direct keys. Each is testable from
  the UI, and a failed test reports *why* — an invalid key and a key missing a
  permission call for different fixes.
- **Platform-level**, set in the environment: `PEXELS_API_KEY`,
  `PIXABAY_API_KEY`, `JAMENDO_CLIENT_ID`, `AI_GATEWAY_API_KEY`. The app boots
  without them; the stage that needs one throws a clear `ProviderError`.

A stored credential takes precedence over the gateway key. Spend is recorded
per call in `ProviderUsage` (`lib/cost.ts`), including what an image actually
cost rather than what survived the reporting.

## Getting started

Requires **Node 24+**, **pnpm**, **Docker**, and **FFmpeg** on `PATH` for local
renders.

```bash
pnpm install
cp .env.example .env
```

Generate the two secrets and paste them into `.env`:

```bash
openssl rand -base64 32   # BETTER_AUTH_SECRET
openssl rand -base64 32   # CREDENTIAL_ENCRYPTION_KEY (must decode to exactly 32 bytes)
```

Start the database, apply the schema, seed the operator account:

```bash
docker compose up -d postgres
pnpm db:migrate
pnpm db:seed          # reads SEED_USER_EMAIL / SEED_USER_PASSWORD
pnpm promote:operator "$SEED_USER_EMAIL"
pnpm dev
```

Sign in at http://localhost:3000/sign-in. To actually produce a video you also
need a worker running:

```bash
pnpm worker
```

Or drive one video by hand, with full stage output:

```bash
pnpm render <videoId> [--force-narration]
```

### Full containerised stack

```bash
docker compose --profile full up --build
```

This is local-development only, and unrelated to `deploy/docker-compose.yml`.

## Environment

`src/config/env.ts` is authoritative — it validates with Zod at import and
refuses to boot on anything malformed. `.env.example` documents the common set.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Pooled connection used at runtime. |
| `DIRECT_URL` | yes | Unpooled connection used by migrations. |
| `BETTER_AUTH_SECRET` | yes | Session signing. |
| `BETTER_AUTH_URL` | yes | Auth base URL. |
| `CREDENTIAL_ENCRYPTION_KEY` | yes | 32 bytes base64; encrypts provider keys at rest. |
| `NEXT_PUBLIC_APP_URL` | yes | Public origin. |
| `STORAGE_ROOT` / `RENDER_ROOT` | defaulted | Where objects and finished renders live. |
| `AI_GATEWAY_API_KEY` | optional | Vercel AI Gateway; a stored credential wins over it. |
| `AI_SCRIPT_MODEL` | defaulted | `anthropic/claude-sonnet-5` |
| `AI_IMAGE_MODEL` | defaulted | Thumbnails and logos. |
| `AI_ILLUSTRATION_MODEL` | defaulted | Per-scene stills for illustrated/cinematic channels. |
| `ELEVENLABS_VOICE_ID` / `ELEVENLABS_MODEL_ID` | defaulted | Narration defaults. |
| `PEXELS_API_KEY`, `PIXABAY_API_KEY` | optional | Stock footage. |
| `JAMENDO_CLIENT_ID` | optional | Music bed; without it videos render silent underneath. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | optional | YouTube OAuth. |
| `AUTH_ALLOWED_EMAILS` | optional | Comma-separated; approved at creation. Grants approval, not role. |
| `PASSWORD_RESET_DELIVERY` | defaulted | `log` — there is no mailer. |
| `SUPABASE_CA_CERT` | conditional | Supabase's CA, since it isn't in Node's trust store. |
| `DATABASE_SSL_INSECURE` | flag | Encrypts but doesn't authenticate. Refused when `NODE_ENV=production`. |
| `DATABASE_SSL_DISABLE` | flag | No TLS. Only allowed for a single-label (private) hostname. |
| `SEED_USER_*` | dev | Seed account. |
| `WORKER_ID` | worker | Names the process in status events. |
| `GOOGLE_SITE_VERIFICATION` | optional | Read at **build** time — set it before `next build`. |

## Scripts

| Script | Purpose |
| --- | --- |
| `pnpm dev` | Dev server (Turbopack) |
| `pnpm build` | `prisma generate` + production build |
| `pnpm start` | Production server |
| `pnpm worker` | Render worker loop |
| `pnpm render` | One-video pipeline CLI |
| `pnpm verify` | `lint && typecheck && test` — the gate before any commit |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | Individually |
| `pnpm db:migrate` / `db:deploy` / `db:push` | Create+apply / apply / prototype |
| `pnpm db:seed` | Operator, settings, default prompts |
| `pnpm db:studio` | Prisma Studio |
| `pnpm promote:operator <email>` | Grant `OPERATOR` (`--demote` reverses it) |
| `pnpm migrate:storage` / `migrate:renders` / `migrate:relink` | One-shot migration helpers used by the VPS runbook |

## Testing

89 test files, run with Vitest.

Service tests run against a **real Postgres and the real storage root**, not
mocks — only `fetch` and process spawning are injected. That has two
consequences worth knowing before you run anything:

- `fileParallelism` is off, because every test file shares one database and
  parallel files would race on the same rows.
- **Never run two `vitest` processes at once** for the same reason — a watcher
  in one terminal and `pnpm test` in another will produce failures that have
  nothing to do with your change.

`DATABASE_URL` must point at a database you are willing to have truncated.

## Conventions

- **ESLint is the only formatter.** There is no Prettier config in this repo,
  and `npx prettier` will happily pull a copy down and silently reformat
  everything. Don't.
- **Migration folder timestamps run ahead of the calendar.** Name a new
  migration after the newest existing folder, not after today's date, or it
  files itself into the middle of history and never runs on a deployed database.
- **Comments explain why, not what.** The codebase is unusually heavily
  commented, and the comments carry the reasoning behind decisions that look
  arbitrary — read the one above the thing you're about to change.
- Zod schemas in `schemas/` are shared by the form and the server boundary; the
  client never validates something the server doesn't re-check.

## Deployment

Production runs on a single OVH VPS (2 vCPU, 4GB, 40GB) with everything in
`deploy/`:

- **`caddy`** — the only service bound to 80/443. Terminates TLS for
  `framecasts.com` and `staging.framecasts.com`, and reverse-proxies without
  buffering so renders stream by byte range.
- **`postgres`** — one instance, two databases: `framecast` and
  `framecast_staging`. A second instance would cost ~400MB for isolation two
  databases already provide.
- **`app-prod` + `worker-prod`**, **`app-staging` + `worker-staging`**.

Two rules the box depends on:

- **`worker-staging` is not started by `docker compose up -d`.** It sits behind
  the `staging-worker` profile. A render already saturates both cores for ~11
  minutes; two at once would starve the site itself.
- **The four bind-mounted host directories must be `chown 1001:1001` before
  first start.** All four services run as UID 1001. Docker creates missing
  bind sources as `root:root`, and a container that can read but not write the
  directory fails post-publish render cleanup *silently* — and the 40GB disk
  fills.

Images are built on the box. Nightly backups go to R2 via a systemd timer.
The full step-by-step is `docs/vps-deployment.md`; the stack's own notes are in
`deploy/README.md`.

## Repo map

```
src/
  app/          routes: (auth), (dashboard), api/, public pages
  features/     admin analytics auth automation channels dashboard logs
                marketing onboarding projects prompts providers settings
                studio videos
  services/     ~45 services + providers/ (elevenlabs, gateway, image, music,
                stock-footage) + pipeline-runner.ts + composer.ts
  lib/          storage, ffmpeg-command, captions, cost, crypto, youtube-*, …
  config/       env.ts, navigation.ts
worker/         the render worker + its Dockerfile
scripts/        render CLI, seeds, storage/render migrations, promote-operator
prisma/         schema.prisma, 37 migrations, seed.ts
deploy/         production VPS stack (Caddy, compose, provisioning, backups)
docs/           vps-deployment.md + superpowers/{specs,plans}
```

`docs/superpowers/specs/` holds the design document behind each feature and
`docs/superpowers/plans/` the plan it was built from. When something in the code
looks deliberate and unexplained, the spec is usually where the reason is.
