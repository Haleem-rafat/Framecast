# deploy/

Everything needed to run Framecast on the production VPS: one Caddy, one
Postgres holding two databases, and a production and a staging environment
each with its own app and worker. Sized for the box it runs on — 2 vCPU, 4GB
RAM, 40GB disk.

This is the **server's** stack. It is unrelated to the `docker-compose.yml`
at the repo root, which is for local development only — do not merge them.

## Services

| Service           | What it is                                                                 |
| ------------------ | --------------------------------------------------------------------------- |
| `caddy`            | The only service bound to the host's ports (80/443). Terminates TLS for `framecasts.com`/`www.framecasts.com` and `staging.framecasts.com`, obtains and renews certificates automatically, and reverse-proxies to the two app containers without buffering (renders stream by byte range). |
| `postgres`         | One Postgres instance holding two databases: `framecast` (production, created by `POSTGRES_DB`) and `framecast_staging` (staging, created once by `init-staging-db.sh` on first boot). A second Postgres instance would cost ~400MB of this box's 4GB for isolation the two databases already give. |
| `app-prod`         | The Next.js app serving `framecasts.com`. |
| `worker-prod`      | The render worker for production. Polls the database and runs the pipeline; no HTTP, no auth. |
| `app-staging`      | The Next.js app serving `staging.framecasts.com`. Sends `X-Robots-Tag: noindex, nofollow` since it holds the same kind of unpublished work as production. |
| `worker-staging`   | The render worker for staging. **Not started by `docker compose up -d`** — see below. |

## `worker-staging` is deliberately not started automatically

The box has 2 vCPUs. A render already takes about eleven minutes on both
cores; two renders running at once (one prod, one staging) would make both
slower and leave the site itself starved of CPU. Rather than build a
cross-environment lock, `worker-staging` sits behind the `staging-worker`
Compose profile, which only ever starts when an operator asks for it:

```bash
# Start it for a staging test run:
docker compose --profile staging-worker up -d worker-staging

# Stop it when done:
docker compose stop worker-staging
```

`docker compose up -d` (no profile) never touches `worker-staging`.

## File ownership: the host directories must be chowned to 1001:1001 before first start

`app-prod`, `worker-prod`, `app-staging`, and `worker-staging` all run as
**UID 1001, GID 1001** — a non-root user baked into both images
(`app/Dockerfile`'s `nextjs` user and `worker/Dockerfile`'s `worker` user)
and stated again explicitly in this Compose file as `user: "1001:1001"` on
each of the four services, so the contract doesn't depend on nobody ever
changing an image's `USER` line.

That matters because of what each pair bind-mounts:

```
/srv/framecast/prod/storage    -> /data/storage    (app-prod, worker-prod)
/srv/framecast/prod/renders    -> /data/renders    (app-prod, worker-prod)
/srv/framecast/staging/storage -> /data/storage    (app-staging, worker-staging)
/srv/framecast/staging/renders -> /data/renders    (app-staging, worker-staging)
```

Docker creates a bind-mount source directory that doesn't already exist as
`root:root`, and a directory created by `mkdir` during provisioning is
`root:root` too. A container running as UID 1001 can *read* a root-owned
directory (typical default permissions are world-readable), but it cannot
**write or delete** inside one — unlinking a file needs write permission on
the directory, not the file. Left unfixed, this means the post-publish
render cleanup in `publish.service.ts` fails silently on every publish (it
only logs a warning), finished renders are never reclaimed, and the 40GB
disk fills exactly the way Task 5 exists to prevent.

**Before the stack is started for the first time**, chown these four
directories to UID:GID 1001:1001:

```bash
mkdir -p /srv/framecast/prod/{storage,renders} /srv/framecast/staging/{storage,renders}
chown -R 1001:1001 /srv/framecast/prod/{storage,renders} /srv/framecast/staging/{storage,renders}
```

No matching user needs to exist on the host — `chown` accepts a bare numeric
UID:GID, and only the *number* has to agree with what the containers run as.
This is a one-time step per fresh directory; it does not need to be repeated
after every deploy, only after `mkdir`ing a new one (e.g. provisioning a
rebuilt server, or adding a new environment).

`/srv/framecast/postgres` needs no such step: the `postgres:17-alpine`
entrypoint starts as root and `chown`s its own data directory to the
`postgres` user internally before dropping privileges, every time it finds
one it doesn't already own. The app and worker images have already dropped
to non-root by the time they'd touch their volumes, so nothing inside either
container can do the equivalent for `/data/storage` and `/data/renders` —
that step has to happen on the host, ahead of time.

## `worker-prod`'s CPU weight is a priority, not a cap

`worker-prod` is given `cpu_shares: 512`, half the default weight of 1024
that every other service on the box gets. `cpu_shares` (Docker's name for the
cgroup `cpu.shares`/`cpu.weight` control) is a **relative weight that only
applies under contention** — it is not a ceiling. That is the right tool for
the stated goal: when the box is otherwise idle, `worker-prod` can still use
both cores and a render still takes ~11 minutes; the moment `app-prod` or
`postgres` actually need CPU, the scheduler shifts cycles toward them because
they carry roughly 2x the weight, without anyone hard-limiting the worker to
a fixed fraction of a core all the time (which would stretch every render
regardless of whether the site is under any load at all).

The tradeoff: because it is *fair-share* rather than *preemptive*, the
guarantee is statistical, not instantaneous — the CFS scheduler settles into
the correct ratio over its scheduling period (on the order of 100ms), not
before. If a genuinely hard latency guarantee ever matters more than not
slowing renders down, a hard cap (Compose's `cpus:` field, e.g. `cpus: "1.0"`
on `worker-prod` to always leave one full core free) is the more honest tool
for that job — but it would make every render slower even when nothing else
on the box wants the CPU, which is why this file uses a weight instead.

## Postgres's memory settings

Postgres's defaults assume a much larger machine than this one, so the
`postgres` service pins:

- `shared_buffers=256MB`
- `effective_cache_size=768MB` (a query-planner hint about likely OS cache,
  not an allocation)
- `max_connections=50`
- `work_mem=4MB`

Sanity check against this box: four Prisma-backed processes can be connected
at once (`app-prod`, `worker-prod`, `app-staging`, and `worker-staging` when
started), each defaulting to a `pg` pool of up to 10 connections, i.e. up to
40 of the 50 slots under normal operation — leaving headroom for `psql`,
migrations, and Postgres's own reserved superuser connections. Worst-case
backend memory (all 50 connections active and sorting) is
`shared_buffers` + `max_connections * work_mem` ≈ 256MB + 200MB ≈ 456MB, plus
per-backend overhead — comfortably inside the 4GB total alongside two Next.js
processes and ffmpeg. These numbers were sized for this box, not copied from
a larger one; increase `max_connections` only if a connection-pool-exhaustion
error is actually observed.

## Memory limits, and what happens when one is hit

Every service carries a `mem_limit`. On a box with no memory to spare, an
unbounded process — a leak, or ffmpeg on a larger-than-expected source —
would otherwise be free to grow until the kernel OOM killer steps in and
picks a victim *system-wide*, which without per-container limits is just as
likely to be Postgres or a healthy app process as the one actually at fault.
A per-service cap makes an OOM kill land on the offending container's own
cgroup instead of wherever the kernel's heuristic happens to point, and
`restart: unless-stopped` brings that one container straight back.

| Service         | `mem_limit` | Why                                                                 |
| ---------------- | ----------- | -------------------------------------------------------------------- |
| `caddy`          | 128m        | A reverse proxy; has no reason to need more.                        |
| `postgres`       | 640m        | `shared_buffers=256MB` fixed + worst-case ~200MB across 50 connections, plus headroom. |
| `app-prod`       | 1024m       | Not just "a Next.js server": publishing runs in this process and buffers the whole ~170MB render — see below. |
| `worker-prod`    | 640m        | ffmpeg, one decoder and one encoder at a time — see below.           |
| `app-staging`    | 640m        | Same process and the same publish buffer as `app-prod`; lighter traffic, not a lighter peak. |
| `worker-staging` | 640m        | Off by default. Matches `worker-prod` because it runs the identical pipeline. |

The five services that run by default sum to 3072m (~3GB), leaving ~1GB of
the box's 4GB for the OS, the Docker daemon, and bursts above these numbers
(page cache is reclaimed under pressure before a limit triggers a kill, and
provisioning also adds a 2GB swap file, so this isn't as tight as summing
feels). Starting `worker-staging` on top adds another 640m — expected to be
brief and supervised, per the profile above, not a steady state the box is
sized to hold indefinitely alongside everything else.

### Why `app-prod` gets 1024m and `worker-prod` only 640m

That looks backwards for a box whose expensive job is video encoding. It
isn't, for two reasons.

**The app is not only a web server — it is the uploader.**
`publishVideoAction` (`src/actions/publish.action.ts`) is a Next.js Server
Action, so it runs inside `app-prod`, not `worker-prod`. It calls
`publishService.publish()`, which buffers the entire ~170MB render into
memory because YouTube's resumable upload needs the full byte length up
front, with a transient peak near double that while the chunks are
concatenated. Next.js standalone's own RSS is 150–250MB before any of that.
512m could not survive a single publish. `app-staging` carries the same
number for the same reason: the staging proof in `docs/vps-deployment.md`
publishes a real video.

**An OOM kill is cheap in the worker and expensive in the app.** A worker
killed mid-render loses its lease and any worker re-renders the video
automatically (see the section below). An app killed mid-publish leaves the
`Publication` row stuck at `UPLOADING` — the row is written before the
upload, and `SIGKILL` skips the catch that would mark it `FAILED` — so every
retry returns `ConflictError("This video is already being published.")`
while YouTube may already hold the video, and the manual recovery risks a
duplicate upload. The margin belongs where the failure is unrecoverable.

`worker-prod` can afford 640m because rendering no longer scales with the
video. Both ffmpeg passes hold one decoder and one encoder open at a time
(`src/lib/ffmpeg-command.ts`); memory is flat in clip count and duration.
If a render is ever OOM-killed at this limit, raise `worker-prod` and take
it back from `app-staging` — a staging publish is always supervised, and a
production one is not.

**What happens when a render is killed mid-encode:** the kill is a SIGKILL,
which the worker's SIGTERM handler (in `worker/index.ts`, there for
Railway's redeploys) cannot intercept — the process just stops. The video it
was rendering stays claimed under a lease (`LEASE_SECONDS = 600` in
`src/services/job.service.ts`), renewed every `HEARTBEAT_SECONDS = 30` while
a worker holds it. With the worker dead, that heartbeat stops, the lease
lapses after at most 10 minutes, and `claimNext`'s stale-lease check makes
the video claimable again — any worker (including the one Compose just
restarted) picks it up and renders it again from scratch. No stuck job, no
manual intervention, at the cost of one render's worth of wasted work — the
same recovery path an ordinary crash or redeploy already relies on, not
something new this adds. An app process killed mid-request just drops that
one request; Caddy serves a brief 502 until the restart lands, typically a
few seconds.

## Where things live

- **Compose file, Caddyfile, init script** (this directory): copied to the
  server, not run in place from a repo checkout.
- **Application data** — `/srv/framecast/postgres` (the database), and
  `/srv/framecast/{prod,staging}/{storage,renders}` (uploaded objects and
  finished renders) — lives on the host, outside any container, so a
  container rebuild or image update can never destroy it.
- **Secrets** live only on the server, never in this repo:
  - `/srv/framecast/env/prod.env` and `/srv/framecast/env/staging.env` —
    each app/worker pair's full environment (`DATABASE_URL`,
    `BETTER_AUTH_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`, provider API keys,
    etc.), loaded via each service's `env_file:`. **`STORAGE_ROOT` must be
    `/data/storage` and `RENDER_ROOT` must be `/data/renders`** in both env
    files — those are the container-side paths this Compose file's volumes
    create, not a default either app picks on its own. Get them wrong (or
    leave them unset, so `src/config/env.ts` falls back to its
    `.framecast/...`-relative defaults) and the app writes into the
    container's own throwaway filesystem instead of the bind mount: nothing
    errors, data is simply gone the moment the container is recreated, and
    the other container sharing that mount never sees it either.
  - A `.env` file next to the Compose file on the server (e.g.
    `/srv/framecast/.env`) supplying the variables Compose itself
    interpolates before any container starts: `GITHUB_OWNER`,
    `POSTGRES_USER`, `POSTGRES_PASSWORD`, and optionally `IMAGE_TAG`. Run
    `docker compose` commands from that same directory (or pass
    `--project-directory`) so this file is picked up.

None of the above are committed. `.gitignore` covers both naming families at
any depth: `.env`/`.env.*` for the app's dot-prefixed files, and `*.env` for
the server's — `prod.env`, `staging.env`, `backup.env`, which do **not**
start with `.env` and so were not covered by the first pattern at all. The
`.example` templates are negated back in. That matters because the runbook's
own workflow is to `scp` an example across and edit it in place, which makes
copying a filled-in one back into a checkout an easy accident. Verify with:

```bash
git check-ignore --no-index deploy/prod.env deploy/staging.env deploy/backup.env
```

All three must be listed. If any is missing, do not create that file inside
a checkout.

## `GITHUB_OWNER` must be lowercase

GHCR (and OCI registries generally) reject uppercase in image paths. The
GitHub owner for this repository is `Haleem-rafat` and the repository is
`Framecast`, but the images Task 8 publishes are:

```
ghcr.io/haleem-rafat/framecast-app
ghcr.io/haleem-rafat/framecast-worker
```

Set `GITHUB_OWNER=haleem-rafat` (all lowercase) wherever it is defined for
this Compose file. Setting it to `Haleem-rafat` will make every
`ghcr.io/${GITHUB_OWNER}/...` image reference invalid.

## `init-staging-db.sh` only ever runs once, against an empty data directory

Postgres's own entrypoint only executes scripts under
`/docker-entrypoint-initdb.d/` the first time it starts against a `PGDATA`
that is completely empty. That's what creates `framecast_staging` — but it
means the script is silently skipped whenever `/srv/framecast/postgres`
already holds data on first boot of a given stack: a restore from backup
(Task 11), a redeploy that reuses an existing volume, or any other path that
doesn't start from a genuinely empty directory. In that case Postgres comes
up with `framecast` but no `framecast_staging`, `app-staging` fails to
connect, and there is no error pointing at why.

If that happens, create the database by hand — it's the same statement the
script would have run:

```bash
docker compose exec postgres createdb -U "$POSTGRES_USER" framecast_staging
```

## Starting the stack

```bash
cd /srv/framecast
docker compose up -d
```

Brings up `caddy`, `postgres`, `app-prod`, `worker-prod`, and `app-staging`.
`worker-staging` is started separately, on purpose — see above.
