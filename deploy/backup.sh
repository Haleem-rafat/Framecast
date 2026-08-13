#!/usr/bin/env bash
#
# deploy/backup.sh
#
# Nightly dump of both databases to Cloudflare R2 — deliberately not OVH. An
# account-level failure, a billing suspension or a mistaken deletion must not
# be able to take the server and its backups together. That is not
# hypothetical: it is what happened to this project's Vercel Blob store on
# 2026-08-12 (see docs/vps-deployment.md, Step 6.2).
#
# OVH's own automated backup covers "the server broke". This covers "the
# account is gone". They are different questions.
#
# Two failure modes a naive version of this script gets wrong, both handled
# below:
#
#   1. A dump that succeeds while producing nothing useful. A byte-count
#      threshold alone can be satisfied by schema noise (many tables, few or
#      zero rows) without the dump containing anything worth restoring, and
#      even "at least one TABLE DATA entry exists somewhere" isn't tight
#      enough — that passes as long as *some* table's data landed in the
#      archive, whether or not it's one of the tables this backup exists to
#      protect. The real guard reads the archive's own table of contents
#      (`pg_restore -l`, which needs no live database connection — just the
#      file) and requires a TABLE DATA entry for each of the tables holding
#      this system's only irreplaceable data: accounts, encrypted provider
#      credentials, and every script and video record (see REQUIRED_TABLES
#      below — names taken from prisma/schema.prisma's @@map, not guessed).
#      The size check stays as a cheap, fast first pass, not the real guard.
#      Neither check proves the *row counts* are right — pg_dump emits a
#      TABLE DATA entry for a table whether it holds one row or a million —
#      that deeper check is what Step 7.4's periodic restore-and-compare in
#      docs/vps-deployment.md is for; this gate only proves the tables that
#      matter were actually included in the dump at all.
#   2. A backup that fails, or never runs at all, with nobody finding out
#      until Supabase is long gone. `Persistent=true` on the timer handles a
#      missed schedule (box was down); it does nothing for a command that
#      runs and fails, or a systemd misconfiguration that stops it running
#      at all. See HEALTHCHECK_PING_URL below and
#      deploy/backup.env.example — optional, but it's the answer to "how
#      would we know". Its blind spot: if backup.env is missing entirely, or
#      malformed enough that systemd refuses to start the service, backup.sh
#      never runs at all and can't ping anything itself — that residual case
#      is exactly what a healthchecks.io-style *grace period* catches (a
#      missed check-in alerts on its own, with no cooperation needed from
#      the thing that failed to check in). The trap and required-var checks
#      below are ordered specifically so that every failure *inside this
#      script* — including a missing R2/Postgres variable — still pings.
set -euo pipefail

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

# Best-effort only, on purpose: a monitoring hiccup (DNS blip, the ping
# endpoint itself being down) must never fail the backup, and must never
# mask the real failure this exists to surface. HEALTHCHECK_PING_URL is
# entirely optional — unset, every call here is a silent no-op and the
# backup behaves exactly as if this didn't exist. See
# deploy/backup.env.example for what to point it at and why.
ping_monitor() {
  [ -n "${HEALTHCHECK_PING_URL:-}" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  curl -fsS -m 10 --retry 2 -o /dev/null "${HEALTHCHECK_PING_URL}${1:-}" || true
}

fail() {
  echo "$1" >&2
  trap - ERR
  ping_monitor "/fail"
  exit 1
}

# Registered before the required-variable checks just below, deliberately —
# so a broken backup.env (say R2_BUCKET missing) still fires a failure ping
# instead of dying silently before monitoring even engages. Catches anything
# that fails without going through fail() itself: the `:?` guards, aws s3
# cp, the pg_dump | gzip pipeline (pipefail means a pg_dump error here fails
# the whole line, not just gzip's), docker compose exec not finding the
# container, etc.
trap 'ping_monitor "/fail"' ERR

: "${R2_BUCKET:?}" "${R2_ENDPOINT:?}"
: "${AWS_ACCESS_KEY_ID:?}" "${AWS_SECRET_ACCESS_KEY:?}"
: "${POSTGRES_USER:?}"

COMPOSE_FILE=/srv/framecast/docker-compose.yml

# The only tables whose loss this task exists to prevent: accounts, encrypted
# provider credentials, and every script and video record — the data that
# can't be reconstructed from anything else (clips can be re-downloaded,
# renders re-rendered). Names are prisma/schema.prisma's @@map values, not
# the PascalCase model names — verified by reading the schema directly:
# User -> user, Video -> video, Script -> script,
# ProviderCredential -> provider_credential.
REQUIRED_TABLES=(user video script provider_credential)

# R2 ignores the actual region value, but the AWS CLI refuses to run at all
# with no region configured anywhere. "auto" is Cloudflare's own documented
# placeholder for this.
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ping_monitor "/start"

for DB in framecast framecast_staging; do
  OUT="$WORK/${DB}-${STAMP}.dump.gz"
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    pg_dump -U "$POSTGRES_USER" --no-owner --no-acl --format=custom "$DB" \
    | gzip -9 > "$OUT"

  # First pass: a dump this small is almost certainly nothing at all (empty
  # output, a connection failure that didn't propagate a non-zero exit).
  # Cheap, but satisfiable without the dump containing anything that
  # actually matters — the table-of-contents check below is the real guard.
  SIZE=$(stat -c%s "$OUT")
  if [ "$SIZE" -lt 10000 ]; then
    fail "Refusing to upload ${DB}: dump is only ${SIZE} bytes."
  fi

  # Second pass: pg_restore -l reads the archive's own table of contents —
  # no live database connection needed, just the file — and lists every
  # entry in it. Each listing line for a data entry has the shape
  # "<id>; <oid> <oid> TABLE DATA <schema> <table> <owner>", so field 7 is
  # the table name. Requiring "at least one TABLE DATA entry, any table"
  # isn't tight enough — that's satisfiable by a dump that happens to carry
  # some inconsequential table's data while missing the ones this backup
  # exists to protect. This checks each of REQUIRED_TABLES by name instead.
  if ! LISTING=$(gunzip -c "$OUT" | docker compose -f "$COMPOSE_FILE" exec -T postgres \
      pg_restore -l - 2>&1); then
    fail "Refusing to upload ${DB}: pg_restore could not read the dump's own table of contents — it may be truncated or corrupt. Output: ${LISTING}"
  fi
  DUMPED_TABLES=$(awk '$4 == "TABLE" && $5 == "DATA" { print $7 }' <<<"$LISTING")
  for TABLE in "${REQUIRED_TABLES[@]}"; do
    if ! grep -qx "$TABLE" <<<"$DUMPED_TABLES"; then
      fail "Refusing to upload ${DB}: table of contents has no TABLE DATA entry for '${TABLE}' — a dump missing one of the tables this backup exists to protect is a failure that produced output, not a usable backup."
    fi
  done

  aws s3 cp "$OUT" "s3://${R2_BUCKET}/postgres/$(basename "$OUT")" \
    --endpoint-url "$R2_ENDPOINT"
  log "Uploaded $(basename "$OUT") (${SIZE} bytes)."
done

ping_monitor ""
