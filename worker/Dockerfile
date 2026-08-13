# syntax=docker/dockerfile:1
#
# The render worker — the same codebase as the Next.js app, deployed a second
# time with a different entry point. It serves no HTTP and authenticates
# nobody; it polls the database for claimable videos and runs the pipeline.
#
# Debian (`slim`) rather than the Alpine base the app image uses. The render
# needs libx264, aac and the `subtitles` (libass) filter, and Debian's ffmpeg
# package ships a full build of all three. Alpine's is leaner and its exact
# codec set varies by release — a missing encoder would surface as an FFmpeg
# failure mid-render on Railway rather than as a build error here, which is
# the worst place to discover it.

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# ---- Dependencies ---------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# `postinstall` runs `prisma generate`, so the schema has to be in place first.
#
# Dev dependencies are installed deliberately: the worker runs through `tsx`
# (see the `worker` script), which is a devDependency. There is no build step
# that would strip it back out, so a `--prod` install would produce an image
# that cannot start.
# No `--mount=type=cache` here, deliberately. Railway's builder requires every
# cache mount id to carry its own cache-key prefix and rejects a bare one
# outright ("missing the cacheKey prefix from its id"), which fails the build
# before a single layer runs. The mount only ever saved download time on
# rebuilds, so portability across builders is worth more than it is.
RUN pnpm install --frozen-lockfile

# ---- Runtime --------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production

# ffmpeg is the whole point of this container. `--no-install-recommends` keeps
# the image from pulling in a desktop's worth of optional codecs.
# `fonts-dejavu-core` is not optional decoration: captions are burned in with
# libass, which resolves a font by name and falls back *silently* when it is
# missing. Without this the styled captions would render in the default face
# and look like the styling simply had not been applied.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Regenerate the Prisma client inside the image rather than shipping the one
# from the repo. `src/generated` is committed, but it is generated on the
# operator's macOS ARM machine, and Prisma's client is built against the
# platform it was generated on — carrying that into a linux container is how
# you get an engine mismatch at runtime instead of at build time. It is
# excluded in .dockerignore for exactly this reason, so this step is what puts
# a correct client in the image.
RUN pnpm prisma generate

# Fail fast and loudly if the image was built without the codecs the pipeline
# needs, rather than discovering it when a render dies eight minutes in. The
# font is checked for the opposite reason: a missing one never fails at all,
# it just quietly produces captions in the wrong face.
RUN ffmpeg -hide_banner -encoders | grep -q libx264 \
    && ffmpeg -hide_banner -encoders | grep -q ' aac ' \
    && ffmpeg -hide_banner -filters  | grep -q subtitles \
    && test -f /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf \
    && echo "ffmpeg has libx264, aac, subtitles and the caption font"

# Non-root, matching app/Dockerfile's UID:GID (1001:1001) exactly. This used
# to run as root on the strength of holding no persistent volume — Task 7
# gave it one (/data/storage, /data/renders, bind-mounted from the host and
# shared with the app container), which is exactly the condition under which
# that reasoning no longer applies. `useradd --gid 1001` (Debian, unlike
# Alpine's `adduser -S` in app/Dockerfile) makes the primary group explicit
# rather than whatever `useradd` would default it to. The host directories
# under /srv/framecast are chowned to 1001:1001 once, in provisioning — see
# deploy/README.md; only the numeric UID has to agree for either container to
# write there; the GID is set to match for legibility, not because anything
# depends on it.
# `--create-home` (not `--no-create-home`) deliberately: Docker's `USER`
# directive does not update `$HOME`, so without a real, owned home directory
# `npx`/npm would inherit root's `$HOME` and fail writing its cache the first
# time this container runs — a permission error that would only show up at
# runtime, not at build time.
RUN groupadd --gid 1001 nodejs \
    && useradd --uid 1001 --gid 1001 --create-home --shell /usr/sbin/nologin worker
ENV HOME=/home/worker
USER worker

# Not `pnpm worker` — pnpm would sit in the process tree between the init
# process and node, and SIGTERM (which Railway sends on redeploy) would reach
# pnpm rather than the worker. The worker's own SIGTERM handler is what lets it
# finish the video it is holding instead of stranding it under a live lease.
CMD ["npx", "tsx", "--conditions=react-server", "worker/index.ts"]
