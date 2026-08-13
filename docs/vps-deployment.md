# VPS deployment runbook

How Framecast's production and staging environments run on the OVH VPS that
replaces Vercel, Supabase and Railway. This document is written to be
followed top to bottom by whoever has SSH access, without having to
reconstruct anything from memory or from this migration's history.

**Scope of this page today:** provisioning only — turning a bare box into
one that can run `deploy/docker-compose.yml`. Deploying the stack for the
first time, migrating data across, nightly backups, and the DNS cutover are
separate steps covered by later sections this document grows as those are
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

Handled by `provision.sh`, which runs (guarding each part so a re-run
neither duplicates the swapfile nor duplicates the `/etc/fstab`/
`sysctl.conf` lines):

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab   # only if not already present

sysctl -w vm.swappiness=10
echo 'vm.swappiness=10' >> /etc/sysctl.conf       # or replaces an existing line
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

Also handled by `provision.sh`:

```bash
curl -fsSL https://get.docker.com | sh
docker --version && docker compose version
```

Skipped if `docker` is already on the `PATH`, so a re-run doesn't reinstall
over a working setup. Confirm both version commands print real version
strings before moving on; a silent failure here would otherwise only
surface later, confusingly, when Step 4's `docker compose up` (a later
runbook section) can't find `docker` at all.

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

## Status

Nothing on this page has been executed against `51.38.80.36`. As of this
writing the operator has not yet run `ssh-copy-id` against the box, so no
key is installed and the host answers SSH with
`Permission denied (publickey,password)`. This document, `deploy/provision.sh`,
`deploy/prod.env.example` and `deploy/staging.env.example` are the reviewable
procedure; running it for the first time is the first real test of all of
it, same as `deploy/docker-compose.yml` and the Dockerfiles it runs remain
unverified until `docker compose up` actually executes somewhere.
