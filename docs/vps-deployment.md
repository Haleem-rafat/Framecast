# VPS deployment runbook

How Framecast's production and staging environments run on the OVH VPS that
replaces Vercel, Supabase and Railway. This document is written to be
followed top to bottom by whoever has SSH access, without having to
reconstruct anything from memory or from this migration's history.

**Scope of this page today:** the whole path, start to finish — provisioning
(turning a bare box into one that can run `deploy/docker-compose.yml`),
migrating the existing data across, nightly backups with a restore
procedure, deploying the stack for the first time, cutting DNS over from
Vercel, watching production, retiring Railway/Vercel/Supabase once that
watch is clean, and the routine deploy that follows for everything after.
This is the last section this document grows for this migration — if a step
you're looking for isn't below, it doesn't exist anywhere yet, not just here.

**Every command below runs on the server, as root**, unless stated
otherwise. None of it has been executed as of this writing — see
[Status](#status) at the end.

## The server

| | |
|---|---|
| Hostname | `vps-940eaa43.vps.ovh.net` |
| IP | `51.38.80.36` |
| Region | London |
| OS | Ubuntu 26.04 |
| Specs | 2 vCPU, 4 GB RAM, 40 GB disk |

## Before you touch anything: get a working SSH key in place

OVH hands you a box with password login enabled and no key installed. Step 1
below turns password login off — if you run it before a key actually works,
you lock yourself out with no console access assumed available. From your
own workstation:

```bash
ssh-copy-id root@51.38.80.36
```

`ssh-copy-id` connects once, installs the key, and disconnects — it leaves
nothing running. It is not the fallback. Do these two things, in order,
before Step 1 runs anything:

1. In a **second terminal**, confirm a plain `ssh root@51.38.80.36` logs in
   with no password prompt. Only proceed once that succeeds.
2. In that same second terminal, **stay logged in** — you now have a real,
   persistent `ssh root@51.38.80.36` session open. Keep it connected through
   all of Step 1, including the point where it disables password auth and
   reloads `sshd`. This session is the only way back into the box if the key
   turns out not to work after all (a wrong key pushed, a permissions
   problem `ssh-copy-id` didn't catch, anything else). It is already
   authenticated, so it stays usable even after password login is turned
   off and even if a *new* login with the key would now fail for some
   reason. **Closing it before you've verified everything in Step 1 is what
   locks you out** — a third terminal opened after Step 1 runs is not a
   substitute; if the key doesn't actually work, that third terminal simply
   won't connect, keys or password.

Run Step 1's `scp`/`ssh` commands below from a **third** terminal, leaving
the second terminal's already-open, already-authenticated session untouched
throughout. Only close the second terminal once you've confirmed, from a
brand-new fourth terminal, that `ssh root@51.38.80.36` still logs in after
Step 1 has run.

## Step 1: Harden the host

OVH's own documentation is explicit that securing the machine is the
customer's responsibility — on a managed platform (Vercel, Railway) this
step didn't exist because the platform did it. Here it's ours: a firewall
that only opens the ports the stack actually uses, `fail2ban` against
SSH brute-forcing, unattended security patches, and password login turned
off in favor of keys.

Copy `deploy/provision.sh` to the server and run it as root:

```bash
scp deploy/provision.sh root@51.38.80.36:/root/
ssh root@51.38.80.36 'bash /root/provision.sh'
```

The script covers this step along with Steps 2–4 below in one idempotent
pass — see its own header comment for what "idempotent" means here and why
it matters (this is also the recovery procedure after a rebuild). Before it
disables password auth, it refuses to continue if `/root/.ssh/authorized_keys`
is empty, as a backstop — but that check only proves a key file exists, not
that login with it actually works, which is why the manual confirmation
above still comes first.

Two things the script deliberately leaves for you to do by hand, and why:

1. **`dpkg-reconfigure -plow unattended-upgrades`** — this is an interactive
   prompt. Run it after the script finishes:

   ```bash
   dpkg-reconfigure -plow unattended-upgrades
   ```

   Accept the default (enable automatic security updates).

2. **Writing the environment files (Step 5 below)** — these hold secrets.
   Nothing that touches them belongs in a script that gets copied around or,
   worse, ever committed.

## Step 2: Swap

Handled by `provision.sh` (its lines 71–88), shown here verbatim — not
simplified, because the guards are the entire point of this being a script
instead of four lines to retype:

```bash
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
else
  # /swapfile already exists — re-running never re-creates or re-formats it,
  # only makes sure it's actually turned on.
  swapon --show=NAME --noheadings | grep -qx /swapfile || swapon /swapfile
fi
# Appends the fstab line only if it isn't already there — a bare `echo >>`
# would duplicate it on every re-run.
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

sysctl -w vm.swappiness=10 >/dev/null
# Replaces an existing vm.swappiness line in place if one exists; only
# appends a new one if it doesn't. A bare `echo >>` would add a second,
# conflicting line on every re-run instead.
if grep -q '^vm.swappiness=' /etc/sysctl.conf; then
  sed -i 's/^vm.swappiness=.*/vm.swappiness=10/' /etc/sysctl.conf
else
  echo 'vm.swappiness=10' >> /etc/sysctl.conf
fi
```

Why it's there: 4 GB with Postgres, two Next.js processes and ffmpeg running
is tight. A 2 GB swap file turns a memory spike into a slowdown instead of
the kernel OOM-killing a container — on top of, not instead of, the
per-container `mem_limit`s already set in `deploy/docker-compose.yml` (see
`deploy/README.md`'s "Memory limits" section for how those two mechanisms
interact). `vm.swappiness=10` tells the kernel to prefer reclaiming page
cache over swapping out a live process, since page cache is cheap to refill
and a swapped-out Postgres backend is not.

## Step 3: Docker

Also handled by `provision.sh` (its lines 91–97), verbatim:

```bash
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
docker --version
docker compose version
```

The `if` is the guard: `get.docker.com`'s installer runs only when `docker`
isn't already on the `PATH`, so a re-run doesn't reinstall over a working
setup. `docker --version` and `docker compose version` run unconditionally
either way — confirm both print real version strings before moving on; a
silent failure here would otherwise only surface later, confusingly, when
Step 4's `docker compose up` (a later runbook section) can't find `docker`
at all.

## Step 4: Directory tree, and why the chown is not optional

Also handled by `provision.sh`. What it creates:

```
/srv/framecast/postgres          # Postgres data directory
/srv/framecast/env               # prod.env, staging.env (chmod 700)
/srv/framecast/prod/storage      # bind-mounted into app-prod, worker-prod
/srv/framecast/prod/renders      # bind-mounted into app-prod, worker-prod
/srv/framecast/staging/storage   # bind-mounted into app-staging, worker-staging
/srv/framecast/staging/renders   # bind-mounted into app-staging, worker-staging
```

Then it runs:

```bash
chown -R 1001:1001 /srv/framecast/prod /srv/framecast/staging
```

**Do not remove this line, and do not "simplify" it away in a future
cleanup.** `app-prod`, `worker-prod`, `app-staging` and `worker-staging` all
run as UID:GID 1001:1001 — baked into both Docker images and stated again
explicitly in `deploy/docker-compose.yml`'s `user: "1001:1001"` on each of
the four services. Docker creates a bind-mount source directory that doesn't
already exist as `root:root`, and a directory this script's `mkdir -p`
creates is `root:root` too, for the same reason. A container running as UID
1001 can *read* a root-owned directory — typical default permissions are
world-readable — but it cannot **write or delete** inside one, because
unlinking a file requires write permission on the containing directory, not
the file itself.

Left unfixed, the consequence is silent: `publish.service.ts`'s post-publish
render reclaim fails on every single publish, logs a warning that nothing
watches, and the 40 GB disk fills up over time exactly the way Task 5 of
this migration (finished-render reclaim) exists to prevent. Nothing about
the app breaks in a way that pages anyone — it just slowly runs out of disk,
weeks or months later, for a reason that "we chowned the directories" would
have explained instantly and "why is the disk full" will not.

`/srv/framecast/postgres` is deliberately excluded from the chown: the
`postgres:17-alpine` image's entrypoint starts as root and chowns its own
data directory to the internal `postgres` user itself, every time it finds
one it doesn't already own. See `deploy/README.md`'s "File ownership"
section for the fuller version of this explanation, including the
comparison of why the app/worker images can't do the equivalent for
themselves.

**Verify it took — this is silent when wrong, so don't skip the check:**

```bash
stat -c '%u:%g %n' /srv/framecast/prod/renders /srv/framecast/staging/renders
```

Expected output, both lines: `1001:1001 <path>`. If either shows `0:0`
(root), the chown didn't run or ran against the wrong path — fix it before
starting the stack, not after.

## Step 5: Write the environment files

`/srv/framecast/env/prod.env` and `/srv/framecast/env/staging.env` hold
every secret the app and worker containers need. **They are written by hand,
directly on the server, and are never committed** — `.gitignore`'s unanchored
`*.env` pattern covers `prod.env`/`staging.env`/`backup.env` if anyone ever
tries (they do not start with `.env`, so the `.env`/`.env.*` patterns alone
never matched them; check with
`git check-ignore --no-index deploy/prod.env` if in doubt). The real
safeguard is still that they never leave the server in the first place.

Templates with every variable name and a placeholder (never a real value)
are committed at `deploy/prod.env.example` and `deploy/staging.env.example`.
Copy each to the server and fill in the placeholders there:

```bash
scp deploy/prod.env.example root@51.38.80.36:/srv/framecast/env/prod.env
scp deploy/staging.env.example root@51.38.80.36:/srv/framecast/env/staging.env
# then edit both in place on the server, e.g.:
ssh root@51.38.80.36 'chmod 600 /srv/framecast/env/*.env'
```

The two files are identical in shape. They differ in exactly three values:
the database name (`framecast` vs `framecast_staging`), the hostname
(`framecasts.com` vs `staging.framecasts.com`), and `JAMENDO_CLIENT_ID`,
**commented out** in staging so test renders don't spend the music quota
shared with production.

| Variable | Notes |
|---|---|
| `NODE_ENV` | `production` in both. |
| `DATABASE_URL`, `DIRECT_URL` | `postgresql://<user>:<password>@postgres:5432/<db>` — `<user>`/`<password>` must match `/srv/framecast/.env`'s `POSTGRES_USER`/`POSTGRES_PASSWORD` (see `deploy/README.md`). |
| `DATABASE_SSL_DISABLE` | `true`. See the dedicated section below — do not copy this setting anywhere else. |
| `BETTER_AUTH_URL`, `NEXT_PUBLIC_APP_URL` | `https://framecasts.com` / `https://staging.framecasts.com`. |
| `STORAGE_ROOT` | `/data/storage` — the container-side path, not a host path. |
| `RENDER_ROOT` | `/data/renders` — same. |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32`. Fine to differ between prod and staging — it only signs each environment's own sessions. |
| `CREDENTIAL_ENCRYPTION_KEY` | **Copy unchanged, same value in both files. Never regenerate.** See below. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | From the Google Cloud Console OAuth client already in use. |
| `AI_GATEWAY_API_KEY` | From the Vercel AI Gateway project. |
| `PEXELS_API_KEY`, `PIXABAY_API_KEY` | Platform-level stock footage keys, not per-operator. |
| `JAMENDO_CLIENT_ID` | Prod only. In `staging.env`, **comment the line out** — do not write `JAMENDO_CLIENT_ID=`. `src/config/env.ts` accepts it absent but rejects the empty string, and `env_file:` passes a bare `NAME=` through as `""`, so an "empty" line stops `app-staging` booting. |
| `SEED_USER_EMAIL` | The seeded operator address / first allowlisted sign-in. |
| `SEED_USER_PASSWORD` | Required by `prisma/seed.ts` alongside `SEED_USER_EMAIL`; it reads both straight from the process environment, so a missing value is only discovered when the seed is run. |

Get `STORAGE_ROOT` or `RENDER_ROOT` wrong (or leave either unset, letting
`src/config/env.ts` fall back to its dev-only relative default) and nothing
errors — the app just writes into the container's own throwaway filesystem
instead of the bind mount, and the data is gone the moment the container is
recreated. `deploy/README.md`'s "Where things live" section covers this
failure mode in more detail.

### `CREDENTIAL_ENCRYPTION_KEY` is the one that will hurt if you get it wrong

Every operator's stored provider API keys (ElevenLabs, and anything else
added through the Providers page) are encrypted at rest with this key. It is
**not** an environment-specific secret to regenerate for the new deployment
— it's a fixed value that has to make the trip from wherever it lives today
(the current production deployment's environment — pull it from Railway's
own dashboard or CLI, the same way it was originally set on the Railway
worker before this migration) to both `prod.env` and `staging.env`
**byte-for-byte identical**.

Generating a fresh one instead of copying the existing value is the failure
mode to guard against: the app will start fine, log in fine, and only fail
the moment an operator's stored key is decrypted — at which point every
credential ever saved is unrecoverable, not just hard to find. There is no
recovery path from that; it is not a bug that gets fixed by looking harder.

**Verify by comparing, not by running anything:** open the value from the
current deployment's environment and the value you're about to paste into
`prod.env` side by side and confirm they match character for character
before saving. That's the only check this page can offer — the stack isn't
running yet at the point Step 5 happens.

**The real end-to-end proof is deliberately deferred, not forgotten.** It's
behavioral: once the stack is up (a later section of this runbook, still
unwritten as of this page), an existing operator's already-saved provider
key (e.g. ElevenLabs) must still decrypt without error. That check can't
exist until there's a running app to check it against, so it belongs to
whichever later task first brings the stack up and verifies it end to end —
prove it in staging before it matters in production.

### Why `DATABASE_SSL_DISABLE=true` is safe here and only here

`src/config/env.ts` refuses `DATABASE_SSL_DISABLE` unless `DATABASE_URL`'s
host is a syntactically single-label name — no dots, and not an IPv4/IPv6
address literal (see `isSingleLabelHostname`'s doc comment in that file for
exactly what the check does and doesn't prove). `postgres` — the Compose
service name used as the hostname in the URLs above — is exactly that kind
of name, and the connection to it never leaves the Docker Compose network's
own network namespace on this one host. That combination is why turning off
TLS negotiation here isn't a security lapse: there's no real network segment
for a middleperson to sit on. The same setting pointed at any dotted domain
or IP address would be a genuine one, which is exactly what the single-label
check exists to prevent by construction — don't copy `DATABASE_SSL_DISABLE`
into any environment where the database isn't reached through this same
Compose network.

## Step 6: Migrate the data

Everything that was ever written to Supabase Storage, the six finished
renders in Vercel Blob, and the Postgres database itself — carried from the
operator's live production account onto this box. **Files first, database
last**, so a running app never finds a database row pointing at an object
that hasn't arrived yet.

`scripts/migrate-storage.ts`, `scripts/migrate-renders.ts` and
`scripts/relink-renders.ts` are one-shot: committed so this migration is
reviewable and repeatable, not kept as permanent tooling — Task 12 deletes
them, and `@supabase/supabase-js` and `@vercel/blob` (both `devDependencies`,
added back only for this migration) along with them, once they've run for
real. None of the three deletes or modifies anything at the source (Supabase,
Blob) — the two copy scripts are a copy, never a move, and the third only
ever writes to *this* database. All three are resumable: run any of them
again after any failure and whatever already succeeded is skipped, not
redone.

**This step assumes the stack is already up** (`docker compose up -d` from
`/srv/framecast` on the server) — which nothing before this point in the
document has done yet. If you're reading top to bottom for the first time,
that's Step 8 below, out of order relative to where you're reading now: this
step and Step 7 immediately after it were written before Step 8 existed and
still read as if the stack already exists, because in the real sequence of
running this whole runbook it does — Step 8 is where an operator actually
brings it up for the first time, before ever reaching this step's commands
for real. Read Step 8 first if the stack isn't up yet; come back here once it
is. Every command below that runs inside a container targets **`worker-prod`**,
never `app-prod` — see the explanation
in Step 6.4, which is where it first matters, for why. `app-prod` is built
from `Dockerfile` at the repo root, a standalone Next.js runtime image that
deliberately excludes the Prisma schema, the migrations directory,
`scripts/`, and every devDependency; `worker-prod` is built from
`worker/Dockerfile`, which copies the whole source tree and keeps
devDependencies (it runs the pipeline through `tsx`, itself one), so it is
the only container in this stack that can run any of these commands at all.

### Step 6.1: Copy every stored object

**On the server**, from `/srv/framecast`, inside `worker-prod` — the
Supabase credentials are passed as one-off environment overrides on the
`exec` itself, never written to `prod.env`:

```bash
docker compose exec \
  -e SUPABASE_URL=... \
  -e SUPABASE_SERVICE_ROLE_KEY=... \
  -e SUPABASE_STORAGE_BUCKET=... \
  worker-prod npx tsx --conditions=react-server scripts/migrate-storage.ts
```

Get the service role key and bucket name from the Supabase dashboard
(Project Settings → API, and Storage) — never from a file in this repo.
These three `SUPABASE_*` variables are read straight from the process
environment, not from `.env`/`.env.local`/`prod.env` — Task 6 removed them
from `src/config/env.ts`'s schema once the app itself stopped needing them,
and this script deliberately does not resurrect them there.

`STORAGE_ROOT` needs no override here: `worker-prod`'s `prod.env` already
sets it to `/data/storage`, the container-side path bind-mounted from
`/srv/framecast/prod/storage` (see Step 4) — so the script writes straight
to its real destination, with no intermediate staging directory or `rsync`
to get it there afterward. The script prints a running count as it recurses
the bucket, and a final total; a non-zero exit means at least one object
failed and should be investigated before moving on — re-running is safe and
only retries what didn't already land.

### Step 6.2: Copy the six finished renders

**Requires the Vercel Blob store to be un-suspended first** — suspended
means unreadable, not merely slow. Restore billing on the Blob store, then,
**on the server**, from `/srv/framecast`, inside `worker-prod`:

```bash
docker compose exec -e BLOB_READ_WRITE_TOKEN=... \
  worker-prod npx tsx --conditions=react-server scripts/migrate-renders.ts
```

`RENDER_ROOT` is likewise already `/data/renders` via `prod.env` — no
staging directory, no `rsync`.

If the store is still suspended, the script detects this specifically (via
`@vercel/blob`'s own `BlobStoreSuspendedError`, checked on every render
before it's downloaded) and reports it clearly rather than silently
producing zero files — and, if a render is already fully copied from an
earlier run, treats that one as done rather than failed even though the
suspended store means it can't re-verify the byte count. **If you'd rather
not restore billing just to migrate six files, skip this script entirely.**
Step 6.4's SQL nulls `outputUrl` on whatever renders never got copied, which
the app already treats as "this needs re-rendering" everywhere it
matters — not a broken player pointing at a file that isn't there.

Nothing needs to be copied out of this script's output for the next steps —
`scripts/relink-renders.ts` (Step 6.4) finds what landed here by checking
`RENDER_ROOT` directly, from the same container, rather than trusting
anything this script printed.

`RENDER_ROOT`'s destination doubles up as `renders/renders/<videoId>.mp4` —
e.g. `/data/renders/renders/…` inside the container, or
`/srv/framecast/prod/renders/renders/…` if you inspect it from the host.
That's correct, not a bug to flatten if you go looking: `RENDER_ROOT` is the
directory, and `renderPath()` in `src/lib/render-storage.ts` always prefixes
its own `renders/` segment on top of it. Removing the inner one breaks every
path the app resolves afterward.

**Testing this against staging first:** `worker-staging` isn't started by
`docker compose up -d` (see `deploy/docker-compose.yml`), so a bare `exec`
against it fails with "container is not running." Use `run --rm` instead,
which starts a throwaway container for just this command and removes it
afterward rather than leaving a staging worker up and competing with
production for the box's two cores:
`docker compose --profile staging-worker run --rm worker-staging npx tsx --conditions=react-server scripts/migrate-storage.ts`
(and the same substitution for every other `worker-prod` command on this
page). Task 10 itself only ever migrates the operator's real production
data, so staging has no equivalent Step 6 of its own — this is only for
dry-running the mechanism.

### Step 6.3: Move the database

**On the operator's Mac**, with `DIRECT_URL` pointing at Supabase, take the
dump and copy it to the server:

```bash
pg_dump "$DIRECT_URL" --no-owner --no-acl --format=custom --file=framecast.dump
scp framecast.dump root@51.38.80.36:/tmp/
```

**On the server** (`ssh root@51.38.80.36`, then `cd /srv/framecast`), copy
the dump into the running `postgres` container and restore it:

```bash
docker compose cp /tmp/framecast.dump postgres:/tmp/
docker compose exec postgres \
  pg_restore --no-owner --no-acl -U "$POSTGRES_USER" -d framecast /tmp/framecast.dump
```

Don't check `prisma migrate status` yet — the dump reflects Supabase's
schema, which has never seen the `output_url_to_path` migration below (it
was written for this VPS Postgres and was never meant to touch Supabase), so
status would correctly report it pending. Step 6.4 resolves that.

**Why this can't run from the Mac at all:** `deploy/docker-compose.yml`
publishes no port for `postgres` — it's reachable only from other containers
on the Compose network, not from outside the server. Every command from here
on runs on the server, inside the relevant container, for that reason; there
is no route to this database from the Mac to fall back to.

### Step 6.4: Rewrite `outputUrl`

`RenderJob.outputUrl` held an absolute Blob URL; it now holds a path
relative to `RENDER_ROOT` (see `src/lib/render-storage.ts`), or null for a
render that wasn't copied. The rewrite is two parts, both **on the server**,
from `/srv/framecast`, run inside the already-running **`worker-prod`**
container:

```bash
docker compose exec worker-prod npx prisma migrate deploy
```

**Why `worker-prod` and not `app-prod`:** `app-prod`'s image is a
standalone Next.js build that carries no Prisma schema, no migrations
directory, and no CLI — `npx prisma migrate deploy` there would have `npx`
fetch `prisma` from the network and then fail to find anything to apply,
silently rather than loudly (see the intro to this step). `worker-prod`
keeps the full source tree for exactly this kind of reason.

This applies `prisma/migrations/20260813120000_output_url_to_path`, already
committed, unedited — it needs no video ids and no local changes before
running. It unconditionally nulls every `outputUrl` that still looks like a
URL, whether or not Step 6.2 copied that row's render. (An earlier draft of
this migration tried to rewrite the real path directly, scoped to a
hand-edited list of video ids pasted in from `migrate-renders.ts`'s output.
That mechanism is gone: the edit had nowhere correct to live — a version
committed with real ids would leak production video ids into this public
repository, and a version edited only on the Mac could never reach the
database, since the Mac has no route to it and the container's image runs
from whatever was already committed. Nulling everything unconditionally and
re-pointing separately, below, needs none of that.)

```bash
docker compose exec worker-prod npx tsx --conditions=react-server scripts/relink-renders.ts
```

`scripts/relink-renders.ts` re-points `outputUrl` back to a real path for
every `RenderJob` row whose render is actually present at `RENDER_ROOT`
**in this same container** — checked against the filesystem directly, not
against anything printed by Step 6.2 on a different machine (nor, this
time, on a different container: `worker-prod`'s `/data/renders` is the same
bind mount Step 6.2 wrote to). It prints how many rows it re-pointed; Step
6.5 checks that count against the database. Re-running it later (after
restoring Blob billing and re-running Step 6.2) picks up whatever's newly on
disk — it only ever touches a row that's currently null, so nothing already
re-pointed is touched twice.

Table and column names (`render_job`, `outputUrl`, `videoId`) were verified
against `prisma/schema.prisma`'s `@@map`, not assumed from the Prisma model
names; double-check with `\d render_job` in `psql` before running, in case
the schema has moved since.

Then confirm Prisma agrees the schema is current — same container, same
directory:

```bash
docker compose exec worker-prod npx prisma migrate status
```

Expected: `Database schema is up to date!`

### Step 6.5: Verify

On the server, from `/srv/framecast`:

```bash
# Row counts match the source.
docker compose exec postgres psql -U "$POSTGRES_USER" -d framecast \
  -c 'SELECT (SELECT count(*) FROM "user") AS users, (SELECT count(*) FROM video) AS videos, (SELECT count(*) FROM channel) AS channels;'

# outputUrl rewrite matches what relink-renders.ts actually did. Compare this
# count to the "N row(s) re-pointed" number Step 6.4's relink-renders.ts run
# printed — they must be equal. If it's lower, some rows didn't make it in
# (check for errors in that run's output); it can never be higher, since
# nothing else in this migration ever writes a `renders/...` outputUrl.
docker compose exec postgres psql -U "$POSTGRES_USER" -d framecast \
  -c "SELECT count(*) FROM render_job WHERE \"outputUrl\" LIKE 'renders/%';"

# Objects arrived.
find /srv/framecast/prod/storage -type f ! -name '*.type' | wc -l
du -sh /srv/framecast/prod

# Orphaned temp files from an interrupted render copy. writeRenderFile()
# (src/lib/render-storage.ts) writes to a `.tmp-<uuid>` file and renames it
# into place, cleaning the temp file up on any error it catches — but a hard
# kill of migrate-renders.ts (SIGKILL, a dead SSH session, the box
# rebooting) skips that cleanup entirely. Harmless — nothing ever reads a
# `.tmp-*` name — but worth clearing so `du` reflects real usage.
find /srv/framecast/prod/renders -name '*.tmp-*'
```

Then, sign in to the running app and open the Providers page. **DNS hasn't
moved yet at this point either — Step 11 comes after this, not before —**
and by this point in the runbook Step 9 has also paused the Vercel app, so
`https://framecasts.com` the normal way reaches neither the VPS nor a live
Vercel deployment. Reach the VPS directly the same way Step 8's staging test
did: the `/etc/hosts` entries added there already cover `framecasts.com`
(add them now, pointing at `51.38.80.36`, if Step 8 was skipped or they were
already removed). This has to be a real browser session against the app now
running on the VPS — the Providers page is the thing being checked, and
checking it anywhere else checks nothing.

If the stored ElevenLabs key renders as connected rather than as an error,
`CREDENTIAL_ENCRYPTION_KEY` came across correctly — this is the one thing on
this page that cannot be checked any other way. **Do not proceed past this
check.** Everything else here can be redone if something is wrong; a wrong
encryption key cannot — every credential ever saved becomes unrecoverable
the moment it fails to decrypt.

## Step 7: Nightly backups to R2, and a restore that was actually performed

**Like Step 6 above, this step assumes the stack is already up** — Step
7.1's `docker compose cp`/`exec postgres` commands and Step 7.4's restore
both need a running `postgres` container, which nothing before Step 8
brings up. Read Step 8 first if you haven't already; this step (and Step
6 before it) were written before Step 8 existed and still read as if the
stack is a given, because by the time either is actually run for real, it
is.

Cancelling Supabase means backups stop being someone else's job. Managed
Postgres included automated backups; this VPS does not, so `deploy/backup.sh`
dumps both databases nightly and uploads them to Cloudflare R2 — deliberately
not to OVH's own object storage. OVH's automated server backup already
answers "the server broke"; it cannot answer "the account is gone", because
the backups would be gone with it. That distinction isn't theoretical: it's
what happened to this project's Vercel Blob store on 2026-08-12, a billing
suspension mid-render that took the store's readability with it (Step 6.2
above). R2 is a different provider from OVH for exactly that reason — an
account-level failure on one cannot take out the other.

### Step 7.1: Install the AWS CLI, the script, and the timer

**On the server, as root.** Nothing installs `aws` during provisioning, and
`backup.sh` calls it — without this the timer fires nightly, fails with
"command not found", and the operator has no backups at all while believing
they do:

```bash
apt-get install -y awscli
aws --version
```

R2 speaks the S3 API, so the standard client works against it unmodified;
the endpoint is supplied per-command via `--endpoint-url`, not baked into
any config file.

Copy the script and the systemd units:

```bash
scp deploy/backup.sh deploy/framecast-backup.service deploy/framecast-backup.timer \
  root@51.38.80.36:/tmp/
ssh root@51.38.80.36
cp /tmp/backup.sh /srv/framecast/backup.sh && chmod +x /srv/framecast/backup.sh
cp /tmp/framecast-backup.{service,timer} /etc/systemd/system/
```

Write `/srv/framecast/env/backup.env` from `deploy/backup.env.example` — same
rule as `prod.env`/`staging.env` in Step 5: filled in **by hand, directly on
the server**, never committed:

```bash
scp deploy/backup.env.example root@51.38.80.36:/srv/framecast/env/backup.env
# then edit it in place on the server to fill in every placeholder
ssh root@51.38.80.36 'chmod 600 /srv/framecast/env/backup.env'
```

`R2_BUCKET`, `R2_ENDPOINT`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
come from the Cloudflare dashboard (R2 → Manage API tokens, and the bucket's
own settings page). `POSTGRES_USER` must match `/srv/framecast/.env`'s value
(Compose's own interpolation file, not `prod.env`). `HEALTHCHECK_PING_URL` is
optional — see Step 7.2.

Enable and run it once immediately, rather than waiting for 03:00 UTC:

```bash
systemctl daemon-reload
systemctl enable --now framecast-backup.timer
systemctl start framecast-backup.service
journalctl -u framecast-backup.service --no-pager
```

Expected: two `Uploaded ...-<timestamp>.dump.gz (N bytes).` lines, one per
database, no errors.

### Step 7.2: What the script actually guards against, and why

**A dump that succeeds while producing nothing useful.** A byte-count
threshold alone is easy to satisfy without the dump containing anything
worth restoring — a schema with enough tables produces a compressed file
well past any size threshold even with zero rows in every one of them.
`backup.sh` keeps a size check as a cheap first pass (catches a dump that's
essentially empty output), but the real guard reads the archive's own table
of contents with `pg_restore -l` — no live database connection required,
just the file. An earlier version of this guard only required *some* `TABLE
DATA` entry to exist anywhere in the archive; that's satisfiable by a dump
that carries some inconsequential table's data while missing the ones this
backup exists to protect. It now requires a `TABLE DATA` entry by name for
each of `user`, `account`, `channel`, `video`, `script`, `script_version`
and `provider_credential` — not "the tables that seem important" but
specifically the ones with no reconstruction path once lost: `user` is
name/email, but `account` (Better Auth's own model, not `user`) is where the
OAuth/password credentials actually live — access tokens, refresh tokens,
password hashes; `channel` holds the YouTube OAuth tokens for every
connected channel, the same category of material for a different provider;
`script` is a thin pointer, `script_version` holds the actual narration
text, cues, sources and model used (kept both, since a dump with one and
not the other is its own signal something's wrong); `video` is every video
record; `provider_credential` is every operator's encrypted provider API
keys. Clips can be re-downloaded and renders re-rendered — none of these
seven can be reconstructed from anywhere else. Table names are
`prisma/schema.prisma`'s `@@map` values, read from the schema rather than
assumed from the model names — a table named here that doesn't actually
exist would refuse every dump, nightly and silently, so each name is
checked against the schema file directly, not typed from memory. This still
doesn't prove the *row counts* are
right — `pg_dump` writes a `TABLE DATA` entry for a table whether it holds
one row or a million — only that the tables that matter were actually
included in the dump at all. Step 7.4's periodic restore-and-compare is the
check that goes that one level deeper, against real data, on a schedule.

**`TimeoutStartSec=1800` on the service unit.** systemd's system-wide
default start timeout is 90 seconds. Two `pg_dump`s, the integrity check,
and two uploads can outrun that easily once there's real data — without the
override, systemd would silently `SIGTERM` the backup mid-dump the first
night the databases grow past whatever fits in 90s, and that failure looks
exactly like any other line in `journalctl` unless someone already knows to
suspect a timeout.

**A backup that fails, or never runs, with nobody finding out.**
`Persistent=true` on the timer only covers a schedule missed because the box
was down — it runs the backup on next boot instead of skipping it silently.
It does nothing for a command that runs and fails, or a systemd
misconfiguration that stops the timer firing at all; both would otherwise
sit unnoticed in `journalctl` until the day they matter. `backup.sh`
supports an optional `HEALTHCHECK_PING_URL` (a
[healthchecks.io](https://healthchecks.io)-style ping URL, or any compatible
service) — set, it pings `<url>/start` on begin, bare `<url>` once both
uploads succeed, and `<url>/fail` on any failure. The failure trap is
registered before `backup.sh` even checks that `R2_BUCKET`/`POSTGRES_USER`/
etc. are set, deliberately — a `backup.env` missing one of those pings
`/fail` too, rather than dying silently before monitoring engages. That
still has one blind spot the script itself can't close: if `backup.env` is
missing outright, or malformed enough that systemd refuses to start the
service at all, `backup.sh` never runs and can't ping anything itself. A
grace period past 03:00 UTC on the monitoring check is what catches that
residual case — a night the timer never runs at all is caught by the
monitoring service's own missed-check-in alert, not only by failures that
happen to run and then error out loudly. It's optional — unset, every ping
call is a silent no-op and the backup behaves identically, just unobserved.
**Recommended, not yet configured as of this writing** — see Status below.

### Step 7.3: Set the retention rule

**In the Cloudflare R2 dashboard**, on the bucket `backup.sh` uploads to: add
a lifecycle rule deleting objects under the `postgres/` prefix after 30 days.
An unbounded backup bucket is a bill that grows quietly, at roughly (dump
size × 2 databases × 30-ish backups a month) — the 30-day window still
covers "we didn't notice a problem for three weeks" without also covering
"we didn't notice for a year".

**Record here once done:**

- Lifecycle rule set: ⬜ not yet done — record the date below once
  configured.

### Step 7.4: Actually restore one — this is the point of the task

A backup that has never been restored is a belief, not a backup. **On the
server**, from `/srv/framecast`:

```bash
cd /srv/framecast

# Pull back last night's dump for one database.
LATEST=$(aws s3 ls "s3://${R2_BUCKET}/postgres/" --endpoint-url "$R2_ENDPOINT" \
  | grep framecast- | sort | tail -1 | awk '{print $4}')
aws s3 cp "s3://${R2_BUCKET}/postgres/${LATEST}" /tmp/verify.dump.gz \
  --endpoint-url "$R2_ENDPOINT"
gunzip -f /tmp/verify.dump.gz

# Restore into a scratch database — never over a live one.
docker compose exec -T postgres createdb -U "$POSTGRES_USER" restore_check
docker compose cp /tmp/verify.dump postgres:/tmp/
docker compose exec -T postgres pg_restore --no-owner --no-acl \
  -U "$POSTGRES_USER" -d restore_check /tmp/verify.dump

# The counts must match production.
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d restore_check \
  -c 'SELECT (SELECT count(*) FROM "user") AS users, (SELECT count(*) FROM video) AS videos;'

# Compare against the live database before tearing the scratch one down.
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d framecast \
  -c 'SELECT (SELECT count(*) FROM "user") AS users, (SELECT count(*) FROM video) AS videos;'

docker compose exec -T postgres dropdb -U "$POSTGRES_USER" restore_check
```

`$R2_BUCKET`, `$R2_ENDPOINT` and `$POSTGRES_USER` here are the same values
written into `/srv/framecast/env/backup.env` in Step 7.1 — export them in the
shell before running the block above, or source the file (mind that it also
holds the R2 access key).

**Record the counts you saw, with the date, here:**

- Restore verified: ⬜ not yet performed.
- Date: `<fill in>`. Dump used: `<filename>`.
- `restore_check` counts: `users=<N>`, `videos=<N>`.
- Live `framecast` counts at the same time: `users=<N>`, `videos=<N>`.
- Match: ⬜ yes / ⬜ no.

**Supabase is not cancelled until this step has passed and the fields above
are filled in.** Everything else in this migration can be redone if it turns
out wrong; a database that was never proven restorable, discovered only
after the one copy of it is gone, cannot be.

## Step 8: Deploy the stack, then prove it works in staging

Nothing has copied `deploy/docker-compose.yml`, the `Caddyfile`, or
`init-staging-db.sh` to the server yet. Step 1 and `provision.sh` set up the
box, the firewall and the directory tree; Step 5 and Step 7.1 put env files
and the backup tooling in `/srv/framecast` — but nothing before this point
has ever put the Compose stack itself there. Without this step, `docker
compose` has no file to read and nothing to start:

```bash
scp deploy/docker-compose.yml deploy/Caddyfile deploy/init-staging-db.sh \
    root@51.38.80.36:/srv/framecast/
ssh root@51.38.80.36 'chmod +x /srv/framecast/init-staging-db.sh'
```

**`init-staging-db.sh` must be in place and executable before Postgres
starts for the very first time — not shortly after, not "close enough."**
Postgres's own entrypoint only runs scripts under
`/docker-entrypoint-initdb.d/` the first time it starts against a
completely empty `PGDATA` (see `deploy/README.md`'s section on this script
for the fuller version). Bring `postgres` up even once before the script is
in place — an early `docker compose up` to sanity-check something, a
Postgres that's already been started once before during testing — and it
will never create `framecast_staging` on that data directory again: no
error, no log line pointing at why, just `app-staging` failing to connect to
a database that quietly doesn't exist. Copy all three files and `chmod` the
script *before* the `docker compose up -d` below, every time, including on
a rebuilt box.

Also write `/srv/framecast/.env` — the file Compose itself reads to
interpolate `${GITHUB_OWNER}`, `${POSTGRES_USER}`, `${POSTGRES_PASSWORD}`
and, optionally, `${IMAGE_TAG}` before any container starts. This is
distinct from `prod.env`/`staging.env` (Step 5) and from `backup.env` (Step
7.1) — three different files, three different purposes, all under
`/srv/framecast`. Its template is `deploy/compose.env.example`, copied the
same way as the others:

```bash
scp deploy/compose.env.example root@51.38.80.36:/srv/framecast/.env
# then edit it in place on the server
ssh root@51.38.80.36 'chmod 600 /srv/framecast/.env'
```

Set `GITHUB_OWNER=haleem-rafat`, **lowercase** — GHCR
rejects the repository owner's actual GitHub-login case (`Haleem-rafat`);
see `deploy/README.md`'s "`GITHUB_OWNER` must be lowercase" section — and
`POSTGRES_USER`/`POSTGRES_PASSWORD` matching what `prod.env` and
`staging.env` already have baked into their `DATABASE_URL`s.

Then:

```bash
cd /srv/framecast && docker compose pull && docker compose up -d
docker compose --profile staging-worker run --rm worker-staging npx prisma migrate deploy
docker compose --profile staging-worker up -d worker-staging
```

`worker-staging` needs `--profile staging-worker run --rm`, not a bare
`exec` or `up -d worker-staging` alone — it sits behind the `staging-worker`
Compose profile and is stopped by default (see `deploy/README.md`), so a
plain `exec` against it fails outright with "container is not running."
`run --rm` starts a throwaway container for the one command and removes it
immediately afterward, rather than leaving a staging worker up and
competing with production for the box's two cores.

**DNS still points at Vercel at this point — Step 11 is what moves it, and
that's still three steps away.** `deploy/Caddyfile` virtual-hosts strictly
on `staging.framecasts.com` (and `framecasts.com`/`www.framecasts.com`), and
`staging.env`'s `BETTER_AUTH_URL` is pinned to
`https://staging.framecasts.com` — a browser that resolves that hostname the
normal way still gets Vercel's IP, the only answer DNS gives before Step 11.
That either can't reach the VPS at all or, worse, reaches the *old* Vercel
deployment and quietly tests the system this migration is replacing instead
of the one it's supposed to prove. Reach the VPS directly instead: on your
Mac, add temporary entries to `/etc/hosts` (`sudo` required):

```
51.38.80.36  staging.framecasts.com
51.38.80.36  framecasts.com
51.38.80.36  www.framecasts.com
```

This makes only *your* machine resolve those three hostnames straight to
the VPS, bypassing DNS entirely — every other device on the internet still
gets Vercel's answer until Step 11 actually moves it for real. Caddy issues
a real certificate for each hostname on its first request the same way it
will after cutover, so the browser sees a normal, valid `https://`
connection rather than a warning.

**Remove these lines from `/etc/hosts` once Step 11 has moved DNS for
real.** A forgotten entry keeps pinning your Mac to `51.38.80.36` for these
three hostnames indefinitely, silently overriding whatever DNS actually
says from then on — which could as easily hide a real production problem on
the VPS (your machine alone still "sees" the old, frozen answer) as make a
future Vercel-side check behave differently on your machine than everyone
else's.

On `staging.framecasts.com`: sign in, create a video, and run it all the way
through the pipeline — script, narration, footage, and render — then
publish it to an unlisted YouTube video and confirm the thumbnail applies.
This is the first time anything in this stack talks to a real
provider (ElevenLabs, Pexels/Pixabay, YouTube) instead of a mock, and the
first real proof that `worker-prod`'s image actually contains, and can run,
everything Step 10 below will need from it.

```bash
docker compose stop worker-staging
```

Leave it stopped once the test passes — it only ever runs when explicitly
started, by design (see `deploy/README.md`'s "`worker-staging` is
deliberately not started automatically").

## Step 9: Freeze production

Stop the Railway worker — from the Railway dashboard, or `railway down`
against that specific service — so nothing new is written to Supabase
Storage or Vercel Blob by the pipeline while Step 10 copies both. Every
`putObject`/`writeRenderFile` call made *by the pipeline* runs inside a
stage the worker executes (`footage.service.ts`, `voiceover.service.ts`,
`render.service.ts`, `thumbnail.service.ts`, `logo.service.ts`); stopping it
freezes that whole path.

**That is not the whole write path, and treating it as one deletes data.**
`publishVideoAction` (`src/actions/publish.action.ts`) is a Next.js Server
Action — it runs inside the **app** process on Vercel, not the worker — and
calls `publishService.publish()`, which after a successful YouTube upload
calls `reclaimClipStorage()` (`publish.service.ts:512`, deletes the video's
source clips via `removeObjects()`) and `reclaimRenderStorage()`
(`publish.service.ts:518`, deletes the render via `deleteRenderFile()`).
This is new as of Task 5 of this same migration — before it existed, "the
app only reads storage" was true, which is presumably where that assumption
came from. It no longer is. Leaving the Vercel app reachable through Steps
9–10 means one Publish click on any already-rendered video deletes clips or
a render that Step 10 may not have copied yet, permanently — the deletion
and the copy race the same source objects, and there is no undo on either
side.

**Take the Vercel app itself offline for the duration of Steps 9 and 10.**
In the Vercel dashboard: Project Settings → General → **Pause Project**,
type the project name to confirm. A paused project serves `503
DEPLOYMENT_PAUSED` to every visitor — nobody can sign in, create a video, or
publish, which is the actual guarantee this step needs, not a request that
nobody does. Two things to know before relying on it:

- **It is not instantaneous.** Vercel's own docs note it can take several
  minutes to take effect. Confirm the pause has actually landed before
  treating production as frozen and starting Step 10.

  **Do not confirm it with `curl -I https://framecasts.com` or a browser
  tab on the same Mac used for Step 8.** That machine has had
  `framecasts.com` pointed at `51.38.80.36` in `/etc/hosts` since Step 8,
  and `app-prod` is already running there by this point —
  `docker compose up -d` starts it by default in Step 8, no profile
  needed. A request from that machine to that hostname never reaches
  Vercel at all; it hits the VPS's own healthy app and returns `200`
  regardless of what Vercel is doing. That's a check that always passes,
  which is worse than no check — it would tell the operator the freeze
  took when it might not have, and send them into Step 10 with Vercel
  possibly still serving live traffic and still able to run `publish()`,
  reopening the exact race this step exists to close. If you find this
  runbook later with a working `/etc/hosts` entry and a `curl` command
  that appears to confirm a pause, this paragraph is why that combination
  never actually proved anything.

  Confirm the pause for real, instead:
  - **The Vercel dashboard is authoritative and needs no DNS at all.** The
    project's status reads "Paused" directly — this is the check, not a
    proxy for it.
  - **A device with no hosts override is a good second confirmation** —
    a phone on cellular data (not the same Wi-Fi/DNS as the Mac), loading
    `https://framecasts.com` and seeing `503 DEPLOYMENT_PAUSED`.
  - If a command-line check is preferred, it has to genuinely bypass the
    Mac's `/etc/hosts` entry. A plain `curl` does not — it resolves
    hostnames the normal OS way, `/etc/hosts` included, which is exactly
    the trap above. `dig` is different: it queries the DNS resolver
    directly and never consults `/etc/hosts` at all, so `dig +short
    framecasts.com` alone already returns Vercel's real, current answer.
    Feed that into `curl --resolve framecasts.com:443:<that-ip> -I
    https://framecasts.com` to force the *connection* to that address too
    (rather than letting `curl` re-resolve the hostname itself and land
    back on `/etc/hosts`), and the response is genuinely from Vercel's
    edge.
- **It does not auto-resume.** Nothing brings it back until Step 13
  explicitly cancels the project, or you resume it by hand (dashboard, or
  the `Pause a project` REST endpoint) — which you won't need to, since
  Step 13 is the next and only time this project is touched again.

This is a pause, not a cancellation — reversible, and not the "nothing is
cancelled until the replacement is serving real traffic" commitment being
broken. It just means production genuinely stops serving anyone, including
the operator, for the (hopefully short) window Step 10 takes to run — which
is the honest cost of a migration copying live data out from under an app
that can otherwise still write to it.

Postgres stays live throughout: it keeps accepting connections, but with
both the worker stopped and the app paused, nothing is left to write to it
until Step 6.3's `pg_dump` runs and actually freezes its state.

## Step 10: Run the migration

This is Step 6 above, run for real, for the first time, against the
operator's actual production data. In order:

1. Step 6.1 — copy every stored object.
2. Step 6.2 — copy the six finished renders (or skip it — see that step for
   what skipping costs and doesn't).
3. Step 6.3 — move the database.
4. Step 6.4 — rewrite `outputUrl`.
5. Step 6.5 — verify, **including the Providers page check.** Do not
   proceed to Step 11 if the stored ElevenLabs key doesn't come back as
   connected — see Step 6.5's own warning for why that one check is
   different from every other in this migration.

## Step 11: Move DNS

The domain is registered at **GoDaddy**, with nameservers currently
delegated to Vercel — today, Vercel (not GoDaddy) is who actually answers
DNS queries for `framecasts.com`. In the GoDaddy dashboard:

1. Set the nameservers back to GoDaddy's own defaults, taking DNS out of
   Vercel's hands.
2. Add `A` records: `@` → `51.38.80.36`, `www` → `51.38.80.36`, `staging` →
   `51.38.80.36`.
3. Delete any Vercel-specific records left over — its `TXT` verification
   record, and whatever `A`/`CNAME` entries it had been serving.

**Registration itself is unaffected by any of this.** The domain stays
registered at GoDaddy throughout this whole migration; only where DNS
*answers* come from changes. This is also why cancelling Vercel in Step 13
can't take the domain with it — by the time that happens, Vercel is no
longer in the nameserver chain at all.

Propagation takes minutes to hours, not immediately. Watch it resolve:

```bash
dig +short A framecasts.com
```

Once that returns `51.38.80.36`, Caddy issues a certificate on the very
first HTTPS request it receives for that hostname — see `deploy/Caddyfile`;
there is no manual certificate step anywhere in this stack, it's automatic.
Confirm `https://framecasts.com` loads with a valid certificate before
treating cutover as done.

## Step 12: Watch for 48 hours

Render a video end to end on production, the same way Step 8 proved it on
staging. Publish it. Then confirm:

```bash
# The published video's render file should be gone — reclaimed post-publish
# per Task 5. The extra `renders/` is not a typo: RENDER_ROOT is the
# directory, and renderPath() always prefixes its own `renders/` segment on
# top of it (see Step 6.2 above). If a file is still here, the chown from
# provisioning (Step 4) didn't take, and reclaim has been failing silently
# on every publish since cutover.
ls -la /srv/framecast/prod/renders/renders/

# Disk isn't slowly filling.
df -h /

docker compose logs --tail 100 worker-prod
```

Confirm the nightly backup actually ran against the newly-migrated,
now-live data, not just against Step 7.1's original test dump:

```bash
journalctl -u framecast-backup.service --since yesterday
```

## Step 13: Retire the old services

**Only once Step 12 has been clean for the full 48 hours.** In order:

1. Delete the Railway worker.
2. Cancel Vercel — the app, the Blob store, and the DNS zone, none of which
   are serving anything anymore.
3. Cancel Supabase — **but only once Step 7.4's restore has actually been
   performed and its counts recorded in the fields above.** Everything else
   in this migration can be redone if it turns out wrong; a database that
   was never proven restorable, discovered only after the one copy of it is
   gone, cannot be.

Nothing in this step is reversible. Don't run it early to "save a step" —
the entire point of Step 12 is having real evidence in hand before any of
these three commitments gets made.

## Step 14: Remove what is now dead — as its own, later commit

`railway.json` and `docs/worker-deployment.md` describe a deployment path
(Railway) this migration replaces outright, and nothing above this line
ever reads either file — they were deleted in the same commit that added
Steps 8 through this one, alongside this runbook update.

**The three migration scripts follow a different rule, and are deliberately
still in the tree as of that same commit.** They stay until Step 10 has
actually run against real production data and Step 13 has retired the old
services — not before, and not bundled into the commit that wrote this
runbook. The reason: `worker-prod`'s image is built from whatever this
branch's tree contains at build time (Task 8's workflow, dispatched by hand
against this branch, or by whatever commit is checked out when it later
merges to `main`). This branch does not merge until after cutover — so if
the scripts were deleted in the same commit that wrote Steps 8–13 above, the
image Step 8 pulls and Step 10 runs `docker compose exec worker-prod ...`
against would be built from a tree that never had them, on the one branch
where that image is the *only* one that will ever exist for this migration.
That would remove the operator's tools before they've been used, not after —
exactly the mistake this step exists to avoid. Once Step 10 has actually run
for real and Step 13 has retired the old services, remove them in a commit
of their own:

```bash
git rm scripts/migrate-storage.ts scripts/migrate-renders.ts scripts/relink-renders.ts
pnpm remove @supabase/supabase-js @vercel/blob
git add -A
git commit -m "chore: retire the one-shot migration scripts"
```

`scripts/relink-renders.ts` is included even though it doesn't match the
`scripts/migrate-*.ts` pattern named elsewhere — it's one-shot for the
identical reason the other two are, stated in its own header comment: it "is
deleted, along with the other two scripts, once this migration has run for
real." `@supabase/supabase-js` and `@vercel/blob` are `devDependencies`
added back solely for this migration (see Step 6's intro); they have no
caller left once the scripts that imported them are gone, and go with them
for the same delayed-timing reason — `worker/Dockerfile`'s `pnpm install`
reads `package.json` at build time, so a script that still does `await
import("@supabase/supabase-js")` needs the package present in whatever
commit builds the image that runs it.

All three scripts remain reachable in git history after this later commit —
`git log --all --full-history -- scripts/migrate-storage.ts` (or the same
search on GitHub) finds them if a second migration off this box ever needs
the same mechanism again.

## Step 15: The routine deploy

Everything above is the migration — run once, in order, never again after
Step 14. This is what actually happens from here on, far more often than
any of it: an ordinary code change reaching production.

```bash
ssh root@51.38.80.36
cd /srv/framecast
docker compose pull
docker compose up -d
```

If the change includes a Prisma migration, apply it from the **worker**
image, never the app image. `app-prod`'s runtime stage (`Dockerfile` at the
repo root) copies only `public`, `.next/standalone`, and `.next/static` — no
Prisma schema, no migrations directory, no CLI, so `prisma migrate deploy`
run there would have `npx` fetch `prisma` from the network and then find
nothing to apply, silently rather than loudly. `worker-prod`'s image
(`worker/Dockerfile`) does `COPY . .`, so it's the only container in this
stack that carries the schema and the migrations directory (and, until Step
14 removes it, `scripts/`):

```bash
docker compose exec worker-prod npx prisma migrate deploy
```

The same applies to staging, substituting the profile-gated `run --rm` form
for `worker-staging` (see Step 8 above for why a bare `exec` won't work
against it):

```bash
docker compose --profile staging-worker run --rm worker-staging npx prisma migrate deploy
```

## Status

Nothing on this page has been executed against `51.38.80.36`. As of this
writing the operator has not yet run `ssh-copy-id` against the box, so no
key is installed and the host answers SSH with
`Permission denied (publickey,password)`. This document, `deploy/provision.sh`,
`deploy/prod.env.example` and `deploy/staging.env.example` are the reviewable
procedure; running it for the first time is the first real test of all of
it, same as `deploy/docker-compose.yml` and the Dockerfiles it runs remain
unverified until `docker compose up` actually executes somewhere.

Step 6 is in the same state: `scripts/migrate-storage.ts`,
`scripts/migrate-renders.ts`, and the `output_url_to_path` migration are
written and reviewable but have never run against the operator's real
Supabase project, Vercel Blob store, or `51.38.80.36` — the same SSH blocker
above applies, and the source data is a live production account this task
was explicitly written not to touch.

Step 7 is likewise unexecuted: `deploy/backup.sh` passes `bash -n` and a
clean `shellcheck` run, and `deploy/framecast-backup.service`,
`deploy/framecast-backup.timer` and `deploy/backup.env.example` are
reviewable, but none of it has run against real Postgres containers or a
real R2 bucket — the same SSH blocker applies, and no R2 credentials exist
yet to test against even if it didn't. Concretely still open, each requiring
the operator's own access: awscli installed and the timer enabled (Step
7.1), `HEALTHCHECK_PING_URL` configured (Step 7.2, recommended), the R2
lifecycle rule set (Step 7.3), and the restore actually performed and its
counts recorded (Step 7.4) — **both checkboxes above, in Step 7.3 and Step
7.4, are still unchecked**. Supabase must not be cancelled until Step 7.4's
is.

**Steps 8–15 (deploy, cutover, watch, retire, and the routine deploy that
follows) are in the same unexecuted state as everything above — written and
reviewable, nothing run.** Nothing was executed against `51.38.80.36`,
Railway, GoDaddy, Vercel or Supabase while writing them, and nothing at any
of those four was cancelled, modified, or reached in any way; DNS was not
touched. Steps 9 and 13 additionally require the operator's own access to
Railway and Vercel, and Step 11 requires the operator's own access to the
GoDaddy account the domain is registered under — none of which exist from
here.

`railway.json` and `docs/worker-deployment.md` are deleted as of this
commit — see Step 14 for why neither one has any remaining reader.
`scripts/migrate-storage.ts`, `scripts/migrate-renders.ts`,
`scripts/relink-renders.ts`, and the `@supabase/supabase-js`/`@vercel/blob`
devDependencies are **deliberately still present** as of this same commit:
Step 14 explains why removing them now, before Step 10 has actually run for
real, would delete the operator's only tools before they've had a chance to
use them. Their removal is a separate commit, to be made later, once Steps
10 and 13 are both done for real — not part of this one.
