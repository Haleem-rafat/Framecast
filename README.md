# Framecast

An automated pipeline that takes a topic from script → voice → assets → render → publish on YouTube.

Single-operator today. Every table is already scoped by `userId` and every query filters on it, so multi-user is a policy change rather than a migration.

## Stack

| Layer    | Choice                                                          |
| -------- | --------------------------------------------------------------- |
| Frontend | Next.js 15 (App Router), React 19, Tailwind v4, shadcn/ui       |
| State    | TanStack Query (server state), Zustand (client state)           |
| Backend  | Server Actions + Route Handlers, service classes                |
| Data     | PostgreSQL 17, Prisma 7 (`prisma-client` + `@prisma/adapter-pg`) |
| Auth     | Better Auth (email/password, Prisma adapter)                    |
| Storage  | Local disk (`STORAGE_ROOT` for objects, `RENDER_ROOT` for renders) |
| Video    | FFmpeg                                                          |
| Deploy   | Docker + Docker Compose                                         |

## Architecture

Layering is strict and one-directional — the UI never reaches past the service layer:

```
app/          route composition, auth gating, Suspense boundaries
features/     feature-scoped components + types (dashboard, videos, auth, …)
components/   ui/ (shadcn), layout/ (shell), shared/ (cross-feature primitives)
services/     business logic + all data access. The only layer touching Prisma.
server/       server-only concerns (session)
actions/      server actions — thin; validate, call a service, revalidate
schemas/      Zod contracts, shared by forms and server boundaries
lib/          prisma client, auth, typed errors, cn()
config/       env validation, navigation
```

Key invariants:

- **Providers are never called from the UI.** Service classes own every outbound API call.
- **`config/env.ts` is server-only** and fails fast at import if a variable is missing or malformed.
- **Errors are typed** (`lib/errors.ts`). Non-`AppError` throws collapse to a generic internal error, so driver messages never reach the browser.
- **`config/navigation.ts` is the single source** for the sidebar, command palette, and breadcrumbs.
- **Soft delete** via `deletedAt`; every read filters it out.
- **Append-only history**: `VideoStatusEvent`, `ScriptVersion`, `ThumbnailVersion`, `ChannelStatistic`, and `VideoAnalytic` are never updated in place.

## Getting started

Requires Node 24+, pnpm, and Docker.

```bash
pnpm install
cp .env.example .env
```

Generate the two secrets and paste them into `.env`:

```bash
openssl rand -base64 32   # BETTER_AUTH_SECRET
openssl rand -base64 32   # CREDENTIAL_ENCRYPTION_KEY (must decode to exactly 32 bytes)
```

Start the database, apply the schema, and seed the operator account:

```bash
docker compose up -d postgres
pnpm db:migrate
pnpm db:seed        # reads SEED_USER_EMAIL / SEED_USER_PASSWORD
pnpm dev
```

Sign in at http://localhost:3000/sign-in with the seeded credentials.

> Sign-up is disabled when `NODE_ENV=production` — the seed script is the only way to create the operator account.

### Full containerised stack

```bash
docker compose --profile full up --build
```

## Scripts

| Script            | Purpose                              |
| ----------------- | ------------------------------------ |
| `pnpm dev`        | Dev server (Turbopack)               |
| `pnpm build`      | `prisma generate` + production build |
| `pnpm typecheck`  | `tsc --noEmit`                       |
| `pnpm lint`       | ESLint                               |
| `pnpm db:migrate` | Create + apply a migration           |
| `pnpm db:seed`    | Seed operator, settings, prompts     |
| `pnpm db:studio`  | Prisma Studio                        |

## Status

Foundation complete: architecture, schema, auth, dashboard shell, sidebar, top nav, theme system, command palette (`⌘K`).

Feature surfaces beyond the dashboard are routed in `config/navigation.ts` but not yet implemented — each is built one at a time.
