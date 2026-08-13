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
#      threshold alone can be satisfied by schema noise (many tables, zero
#      rows) without the dump containing anything worth restoring, so the
#      real guard is reading the archive's own table of contents
#      (`pg_restore -l`, which needs no live database connection — just the
#      file) and refusing to upload one with no TABLE DATA entries. The size
#      check below stays as a cheap, fast first pass, not the real guard.
#   2. A backup that fails, or never runs at all, with nobody finding out
#      until Supabase is long gone. `Persistent=true` on the timer handles a
#      missed schedule (box was down); it does nothing for a command that
#      runs and fails, or a systemd misconfiguration that stops it running
#      at all. See HEALTHCHECK_PING_URL below and
#      deploy/backup.env.example — optional, but it's the answer to "how
#      would we know".
set -euo pipefail

: "${R2_BUCKET:?}" "${R2_ENDPOINT:?}"
: "${AWS_ACCESS_KEY_ID:?}" "${AWS_SECRET_ACCESS_KEY:?}"
: "${POSTGRES_USER:?}"

COMPOSE_FILE=/srv/framecast/docker-compose.yml

# R2 ignores the actual region value, but the AWS CLI refuses to run at all
# with no region configured anywhere. "auto" is Cloudflare's own documented
# placeholder for this.
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

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

# Catches anything that fails without going through fail() itself: aws s3
# cp, the pg_dump | gzip pipeline (pipefail means a pg_dump error here fails
# the whole line, not just gzip's), docker compose exec not finding the
# container, etc.
trap 'ping_monitor "/fail"' ERR

ping_monitor "/start"

for DB in framecast framecast_staging; do
  OUT="$WORK/${DB}-${STAMP}.dump.gz"
  docker compose -f "$COMPOSE_FILE" exec -T postgres \
    pg_dump -U "$POSTGRES_USER" --no-owner --no-acl --format=custom "$DB" \
    | gzip -9 > "$OUT"

  # First pass: a dump this small is almost certainly nothing at all (empty
  # output, a connection failure that didn't propagate a non-zero exit).
  # Cheap, but satisfiable without the dump containing anything real — the
  # table-of-contents check below is the guard that actually can't be.
  SIZE=$(stat -c%s "$OUT")
  if [ "$SIZE" -lt 10000 ]; then
    fail "Refusing to upload ${DB}: dump is only ${SIZE} bytes."
  fi

  # Second pass: pg_restore -l reads the archive's own table of contents —
  # no live database connection needed, just the file — and lists every
  # entry in it. A dump of a real, populated database always has at least
  # one TABLE DATA entry; a schema-only dump (wrong database somehow
  # targeted, a connection that succeeded against an unexpectedly empty one)
  # does not, no matter how large the schema makes the compressed file.
  if ! LISTING=$(gunzip -c "$OUT" | docker compose -f "$COMPOSE_FILE" exec -T postgres \
      pg_restore -l - 2>&1); then
    fail "Refusing to upload ${DB}: pg_restore could not read the dump's own table of contents — it may be truncated or corrupt. Output: ${LISTING}"
  fi
  if ! grep -q 'TABLE DATA' <<<"$LISTING"; then
    fail "Refusing to upload ${DB}: table of contents lists no TABLE DATA entries — this dump is schema-only or empty, which for a live database is a failure that produced output rather than a genuine empty database."
  fi

  aws s3 cp "$OUT" "s3://${R2_BUCKET}/postgres/$(basename "$OUT")" \
    --endpoint-url "$R2_ENDPOINT"
  log "Uploaded $(basename "$OUT") (${SIZE} bytes)."
done

ping_monitor ""
