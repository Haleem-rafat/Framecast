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
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- Runtime --------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production

# ffmpeg is the whole point of this container. `--no-install-recommends` keeps
# the image from pulling in a desktop's worth of optional codecs.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Fail fast and loudly if the image was built without the codecs the pipeline
# needs, rather than discovering it when a render dies eight minutes in.
RUN ffmpeg -hide_banner -encoders | grep -q libx264 \
    && ffmpeg -hide_banner -encoders | grep -q ' aac ' \
    && ffmpeg -hide_banner -filters  | grep -q subtitles \
    && echo "ffmpeg has libx264, aac and subtitles"

# No `USER node`. The pipeline writes to a temp directory it creates itself and
# cleans up in a `finally`; the container is ephemeral and holds no persistent
# volume. Revisit if this ever gains a mounted disk.

# Not `pnpm worker` — pnpm would sit in the process tree between the init
# process and node, and SIGTERM (which Railway sends on redeploy) would reach
# pnpm rather than the worker. The worker's own SIGTERM handler is what lets it
# finish the video it is holding instead of stranding it under a live lease.
CMD ["npx", "tsx", "--conditions=react-server", "worker/index.ts"]
