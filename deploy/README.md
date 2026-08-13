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
    etc.), loaded via each service's `env_file:`.
  - A `.env` file next to the Compose file on the server (e.g.
    `/srv/framecast/.env`) supplying the variables Compose itself
    interpolates before any container starts: `GITHUB_OWNER`,
    `POSTGRES_USER`, `POSTGRES_PASSWORD`, and optionally `IMAGE_TAG`. Run
    `docker compose` commands from that same directory (or pass
    `--project-directory`) so this file is picked up.

None of the above are committed. `.gitignore`'s unanchored `.env`/`.env.*`
patterns already cover any `.env` placed under `deploy/` too.

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

## Starting the stack

```bash
cd /srv/framecast
docker compose up -d
```

Brings up `caddy`, `postgres`, `app-prod`, `worker-prod`, and `app-staging`.
`worker-staging` is started separately, on purpose — see above.
