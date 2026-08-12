# Self-hosting Framecast on OVHcloud — design

**Goal:** Run the whole of Framecast — web app, render worker, Postgres and every
stored file — on one OVHcloud VPS, in two environments, on `framecasts.com`, and
cancel Vercel and Supabase.

**Status:** Approved by the operator. Ready for an implementation plan.

## Why

Framecast currently spans four paid services: Vercel (app, DNS, Blob), Supabase
(Postgres, object storage), Railway (render worker), and the AI providers. Three
of those four are infrastructure, and the split is actively costing the operator.

On 2026-08-12 the Vercel Blob store `framecast-renders` was suspended for
billing. A render then ran to completion — 38 clip encodes, 37 crossfades, the
SFX bed, the final mux, eleven and a half minutes of CPU — and was destroyed at
the last step, because `writeRenderFile` had nowhere to write. Every render since
fails the same way.

The suspension is the symptom. The cause is that finished renders are ~170 MB,
they are written by one service and served by another, and the transfer between
them is metered. Consolidating onto one machine removes the meter, the second
vendor, and the failure mode together.

A second finding drove the same conclusion. `src/lib/storage.ts:59` hardcodes
`BUCKET_FILE_SIZE_LIMIT_BYTES = 50 * 1024 * 1024`, and
`blob-render-storage.ts` explains that renders bypass Supabase because 170 MB
exceeds "Supabase's free-tier 50 MB object cap". The operator is on Supabase Pro
and has been for some time. The constant outlived its reason, and a whole second
storage vendor exists because of it.

## Decisions taken

| Question | Decision |
|---|---|
| Environments | Staging and production, both on one box |
| Machine | OVH VPS-1 2027 — 2 vCPU, 4 GB RAM, 40 GB NVMe, €3.81/month |
| Host | `vps-940eaa43.vps.ovh.net` — `51.38.80.36`, London (os-uk2), Ubuntu 26.04 |
| Existing data | Move everything — database and all stored files |
| Database backups | Nightly dump to Cloudflare R2, off the OVH account |
| Deploys | GitHub Actions builds images; the server only pulls |
| Published renders | Deleted from disk once YouTube confirms the upload |
| Postgres | Stays self-hosted on the box, one instance, two databases |

## Constraints the machine imposes

VPS-1 is small, and two of its limits shape the design rather than merely
inconveniencing it.

**2 vCPU.** The same core count the render worker has on Railway today, which is
why libx264 runs `threads=2` and a seven-minute video takes eleven and a half
minutes to render. That does not improve here. What changes is that Postgres and
the web app now share those two cores, so **the site will be slow while a video
renders**. This is accepted, not solved. Two mitigations apply: the render
process is niced so interactive work wins contention, and staging's worker is
stopped by default so two renders can never compete.

**4 GB RAM.** Enough for Postgres, two Next.js processes, a worker and Caddy —
but not enough to also run `next build`, which is why images are built on GitHub
rather than on the box. A 2 GB swap file covers spikes.

**40 GB disk.** After the OS and Docker images, roughly 25 GB is usable. At
~170 MB per render that is about 140 videos if nothing is ever deleted, which is
why deleting a render once it is safely on YouTube is a required behaviour rather
than an optimisation.

## Architecture

One VPS running Ubuntu 26.04 and Docker Compose, in OVH's London region. Six
services:

| Service | Purpose |
|---|---|
| `caddy` | TLS termination and routing. Certificates issue and renew automatically |
| `postgres` | One PostgreSQL 17 instance holding two databases |
| `app-prod` | Next.js, serving `framecasts.com` |
| `app-staging` | Next.js, serving `staging.framecasts.com` |
| `worker-prod` | The render worker |
| `worker-staging` | Same image, behind a Compose profile, stopped by default |

### Why one Postgres and not two

Two PostgreSQL containers would cost roughly 400 MB of a 4 GB machine for no
benefit at this scale. One instance with `framecast` and `framecast_staging`
databases gives the same isolation for the data — separate schemas, separate
migrations, no way for staging to read production rows — at a fraction of the
memory. The trade is that a Postgres restart affects both environments, which on
a single-box deployment is already true of every other failure.

### Why staging's worker is stopped by default

A staging render and a production render on two shared cores would make both slow
and the website unusable. Docker Compose profiles keep `worker-staging` defined
but not started; the operator brings it up to test the pipeline and stops it
after. Nothing enforces this in code — it is a documented operating procedure,
because the alternative is a cross-environment lock that adds a failure mode to
solve a discipline problem.

### Filesystem layout

Files live on the host, outside the containers, so a container rebuild cannot
destroy them:

```
/srv/framecast/
  postgres/                 database data
  prod/
    storage/                clips, narration, thumbnails, logos, music
    renders/                finished videos
  staging/
    storage/
    renders/
  env/
    prod.env
    staging.env
```

## Storage rewrite

Two modules currently talk to hosted services. Both are already isolated behind
narrow interfaces — twelve exported functions between them — which is what makes
this a contained change rather than a rewrite.

### `src/lib/storage.ts` — Supabase Storage to local disk

`storagePath()` is pure and does not change. The rest map onto the filesystem:
`ensureBucket()` becomes a directory creation, `putObject()` a file write,
`getObject()` a read, `removeObjects()` an unlink, `objectSizeBytes()` a stat.

**Content type is preserved in a sidecar file** written beside each object. This
is not decoration: `objectContentType()` is load-bearing — the thumbnail upload
reads it to set the `Content-Type` header on `thumbnails.set`, and Task 7 of the
publishing pack can legitimately store a PNG where a JPEG was expected. Inferring
the type from the file extension would work today and break silently the first
time it did not.

### `signedUrl()` is deleted rather than reimplemented

This returns a Supabase URL the browser fetches directly, with the signature
carrying the authorisation. A local disk has no equivalent.

It has **exactly one non-test caller**: `resolvePreviewAsset()` in
`src/app/(dashboard)/videos/[id]/page.tsx:44`, which mints a one-hour URL for the
narration audio preview. That changes the calculus. Rather than invent a signed
-token scheme to preserve an interface with a single user, the narration follows
the route the render already takes: a new `/api/videos/[id]/narration` endpoint
that checks the session and the video's ownership, then streams the file.

`/api/videos/[id]/file` already establishes this pattern, and its own doc comment
argues for it — a route resolving the object server-side from a video id cannot
be used by anyone who merely obtained a URL. Replacing a bearer-token URL with a
session check is a security improvement, not merely a port, and it deletes the
`SIGNED_URL_TTL_SECONDS` expiry problem the page comments already apologise for.

### `src/lib/blob-render-storage.ts` — Vercel Blob to local disk

The same treatment: `writeRenderFile()` writes to `/srv/framecast/<env>/renders/`,
`getRenderFile()` streams from it, `statRenderFile()` stats it,
`deleteRenderFile()` unlinks it.

**`Video.outputUrl` changes meaning.** It currently holds an absolute Blob URL;
afterwards it holds a path relative to the renders directory. Existing rows must
be rewritten as part of the data migration, and the column's doc comment must say
what it now contains.

### Deleting a render after publish

`publish.service.ts` already reclaims stock clips after a successful publish.
Finished renders join them: once YouTube returns a video id, the local file is
deleted. The video is on YouTube; the local copy is redundant, and on 40 GB it is
the difference between a disk that stabilises and one that fills.

This must never fail a publish. It follows the same shape as the existing clip
reclaim — best-effort, after the transaction, errors logged and swallowed.

## Data migration

Four pieces, in order, with the database last so it is never ahead of the files
it references.

**1. Stored files.** A script lists every object in the Supabase bucket and
downloads it to `/srv/framecast/prod/storage/`, preserving paths exactly so
`storagePath()` output continues to resolve. Content-type sidecars are written
from Supabase's stored metadata.

**2. Finished renders.** Six objects, 510 MB, currently in the suspended Blob
store. **Suspended means unreadable**, so this step requires the operator to
restore Blob billing long enough to copy them out. If they choose not to, the
step is skipped and the affected `Video.outputUrl` values are nulled — those
videos are already published on YouTube, so what is lost is the local copy.

**3. Database.** `pg_dump` from Supabase's direct connection, restored into the
`framecast` database on the box. Prisma's migration history comes along, so
`prisma migrate status` reports clean on the other side.

**4. `Video.outputUrl` rewrite.** A migration converts Blob URLs to relative
paths for rows whose render was copied, and nulls the rest.

### The credential key must not change

`CREDENTIAL_ENCRYPTION_KEY` decrypts the operator's stored provider API keys.
Carrying the database without carrying that key turns every stored credential
into unreadable bytes with no recovery. It moves to the new box unchanged, and
verifying that a stored ElevenLabs key still decrypts is an explicit acceptance
check, not an assumption.

`BETTER_AUTH_SECRET` may change — the only consequence is that existing sessions
end and the operator signs in again — but there is no reason to change it.

## Cutover

Ordered so that nothing is cancelled until the replacement is proven.

1. Provision the box: Docker, a 2 GB swap file, a firewall allowing only 22, 80
   and 443, SSH keys only with password login disabled, and unattended security
   updates. OVH's own guidance is explicit that securing the machine is the
   customer's responsibility — on a managed platform this step did not exist.
2. Deploy the staging stack. Smoke-test on `staging.framecasts.com`: sign in,
   create a video, run the pipeline against real providers.
3. Freeze production — stop the Railway worker, publish nothing new.
4. Run the data migration into the production stack.
5. Verify: row counts match, a stored credential decrypts, a signed URL serves a
   file, a render streams.
6. DNS. The domain is registered at **GoDaddy** with nameservers delegated to
   Vercel. Move the nameservers back to GoDaddy's own, then add `A` records for
   the apex and `staging` pointing at the VPS. Registration is unaffected —
   cancelling Vercel cannot take the domain.
7. Watch for 48 hours: render a video end to end, publish it, confirm the
   thumbnail applies and the render is deleted afterwards.
8. Cancel Vercel. Cancel Supabase a few days later, once a backup has been
   restored successfully at least once.

## Backups

The operator is trading managed backups for control, and this is where that trade
is paid for.

A nightly job dumps both databases, compresses them, and uploads to a
**Cloudflare R2 bucket** — deliberately not OVH. An OVH-wide problem, a billing
suspension, or a mistaken account deletion must not be able to take the server
and its backups together. That is not hypothetical: it is what happened to the
Blob store this week, on a different provider.

Thirty days are retained via a bucket lifecycle rule. R2 credentials live in the
server's environment file, never in the repository.

OVH's own "Automated backup — Standard" is enabled on this VPS and is worth
having: it restores the whole machine quickly after a disk failure or a bad
change. It does not replace the R2 copy, because it lives in the same account as
the thing it protects. The two answer different questions — OVH's answers "the
server broke", R2 answers "the account is gone".

**A restore is performed and verified as part of the implementation**, into a
scratch database, before Supabase is cancelled. An untested backup is not a
backup, and the data it protects — accounts, encrypted provider keys, every
script and video record — is the only thing here that cannot be regenerated.

Stored files are **not** backed up off-site. Clips can be re-downloaded, renders
re-rendered, thumbnails regenerated; the cost of losing them is compute, not
information. This is a deliberate limit, revisited if the box ever holds
something irreplaceable.

## Failure handling

| Failure | Behaviour |
|---|---|
| Render written but publish fails | File stays on disk; retry publishes the same file |
| Publish succeeds, render delete fails | Logged, publish unaffected; the file is cleaned up by the next pass |
| Disk fills | Renders fail with a clear disk-space error rather than a truncated file; the delete-after-publish rule is what keeps this rare |
| Postgres container restarts | Both environments interrupted; data intact on the host volume |
| Caddy cannot issue a certificate | Site unreachable over HTTPS; certificates are retried automatically, and staging exercises the path first |
| Nightly backup fails | Logged and alerted; a missed night is tolerable, a silent run of missed nights is not |
| VPS is destroyed | Rebuild from the image, restore the latest dump. Stored files are lost by design; published videos are on YouTube |

## Testing

The storage rewrite is the part with real failure modes, and it is testable
without a server: both modules are pure filesystem code behind existing
interfaces.

- `putObject` then `getObject` round-trips bytes unchanged, including binary.
- `objectContentType` returns what `putObject` was given — specifically that a
  PNG stored through the composite-failure path reports `image/png`.
- `signedUrl` produces a URL that the storage route accepts before expiry and
  rejects after it, and rejects a tampered signature.
- `removeObjects` deletes the object and its sidecar, and tolerates a missing
  file.
- `writeRenderFile` then `getRenderFile` streams identical bytes.
- Deleting a published render never throws into the publish path.

The migration scripts are verified by running them: row counts before and after,
a decrypted credential, a served file.

## Out of scope

A CDN — one box in one region is what this design chooses, and at current traffic
the difference is not measurable. High availability, for the same reason: this is
deliberately a single point of failure in exchange for €3.81 a month and one
vendor. Object storage on OVH, which solves a problem that arrives at roughly 400
videos, not 6. Off-site backup of stored files, per the reasoning above. Moving
the AI providers, which are APIs rather than infrastructure and are unaffected.
