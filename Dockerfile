# syntax=docker/dockerfile:1

# ---- Base -----------------------------------------------------------------
# ffmpeg is required by the render pipeline and must exist in the runtime image.
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# ---- Dependencies ---------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# postinstall runs `prisma generate`, so the schema must be copied first.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---- Build ----------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Placeholders satisfy env validation at build time; real values are injected at
# runtime. No secret is baked into the image.
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
ENV BETTER_AUTH_SECRET=build-time-placeholder-secret-000000
ENV BETTER_AUTH_URL=http://localhost:3000
ENV CREDENTIAL_ENCRYPTION_KEY=YnVpbGQtdGltZS1wbGFjZWhvbGRlci1rZXktMzJieXQ=
RUN pnpm build

# ---- Runtime --------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache ffmpeg
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder /app/public ./public
# `standalone` bundles only the traced runtime deps — no node_modules copy needed.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
