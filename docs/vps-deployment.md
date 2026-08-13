# VPS deployment runbook

How Framecast's production and staging environments run on the OVH VPS that
replaces Vercel, Supabase and Railway. This document is written to be
followed top to bottom by whoever has SSH access, without having to
reconstruct anything from memory or from this migration's history.

**Scope of this page today:** provisioning (turning a bare box into one that
can run `deploy/docker-compose.yml`) and migrating the existing data across.
Deploying the stack for the first time, nightly backups, and the DNS cutover
are separate steps covered by later sections this document grows as those are
built; if you're looking for one of those and it isn't below yet, it hasn't
been written.

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
directly on the server, and are never committed** — `.gitignore`'s
unanchored `.env`/`.env.*` patterns cover them if anyone ever tries, but the
real safeguard is that they never leave the server in the first place.

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
left **empty** in staging so test renders don't spend the music quota shared
with production.

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
| `JAMENDO_CLIENT_ID` | Prod only — leave empty in `staging.env`. |
| `SEED_USER_EMAIL` | The seeded operator address / first allowlisted sign-in. |

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
(the current production deployment's environment — pull it from there, e.g.
via the platform's own env-var UI or CLI, the same way
`docs/worker-deployment.md` describes for the Railway worker today) to both
`prod.env` and `staging.env` **byte-for-byte identical**.

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

This step assumes the stack is already up (`docker compose up -d` from
`/srv/framecast` on the server). Every command below that runs inside a
container targets **`worker-prod`**, never `app-prod` — see the explanation
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

Then, sign in to the running app and open the Providers page. If the stored
ElevenLabs key renders as connected rather than as an error,
`CREDENTIAL_ENCRYPTION_KEY` came across correctly — this is the one thing on
this page that cannot be checked any other way. **Do not proceed past this
check.** Everything else here can be redone if something is wrong; a wrong
encryption key cannot — every credential ever saved becomes unrecoverable
the moment it fails to decrypt.

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
