# Framecast Sub-project 1: Providers + Script — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The operator stores API keys, edits prompt templates, creates a project and a video from a topic, generates a script, reviews it, and approves it — moving the video to `QUEUED`, with every generation's cost recorded.

**Architecture:** Strict one-directional layering already established in this repo: `app/ → features/ → services/ → lib/`. Provider APIs are called **only** from service classes. All data access lives in services; nothing else imports Prisma. Errors are typed (`lib/errors.ts`) and mapped to serialisable shapes at the action boundary.

**Tech Stack:** Next.js 15 (App Router, Turbopack), React 19, TypeScript, Prisma 7 + `@prisma/adapter-pg`, Supabase Postgres, Better Auth, AI SDK v6 via Vercel AI Gateway, Zod v4, TanStack Query, shadcn/ui, Tailwind v4, Vitest.

## Global Constraints

- **Every service file starts with `import "server-only";`** — matches `services/dashboard.service.ts`.
- **Every query is scoped by `userId`** and filters `deletedAt: null` on soft-deletable models.
- **`encryptedKey` is never selected into a client-bound payload.** Use explicit Prisma `select` on every credential read.
- **Append-only history:** `ScriptVersion` and `VideoStatusEvent` rows are inserted, never updated.
- **Path alias is `@/`** → `src/`.
- **Comments explain *why*, not *what*.** Match the terse, declarative voice of the existing files.
- **Product name is "Framecast".** Never "AI YouTube Studio", never any name containing "YouTube".
- **Prompt guardrails:** the seeded SCRIPT template must forbid financial advice, stock picks, price predictions, and promised returns, and must require on-screen sources. This is a monetization requirement, not a preference.
- **Node 24+, pnpm.** Run all commands from the repo root (`ai-youtube-app/`).

---

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `src/lib/crypto.ts` | AES-256-GCM encrypt/decrypt for credentials at rest |
| `src/lib/prompt-template.ts` | `{{variable}}` extraction and rendering |
| `src/lib/cost.ts` | Token counts → USD |
| `src/services/providers/types.ts` | `TextGenerationProvider` interface and its I/O types |
| `src/services/providers/gateway.provider.ts` | AI SDK v6 implementation via Vercel AI Gateway |
| `src/services/provider-credential.service.ts` | Credential vault CRUD, key resolution, connection test |
| `src/services/prompt-template.service.ts` | Prompt template CRUD, default enforcement |
| `src/services/project.service.ts` | Project CRUD |
| `src/services/video.service.ts` | Video CRUD, status transitions, Gate 1 |
| `src/services/script.service.ts` | Script generation, versioning |
| `src/schemas/*.schema.ts` | Zod contracts, one file per feature |
| `src/actions/*.action.ts` | Thin server actions: validate → service → revalidate |
| `src/features/{providers,prompts,projects,videos}/` | Feature-scoped components and types |
| `src/app/(dashboard)/{providers,prompts,projects,videos}/` | Routes |
| `vitest.config.ts`, `src/test/setup.ts` | Test harness |

**Modify:** `src/config/env.ts` · `prisma.config.ts` · `prisma/seed.ts` · `package.json` · `.env.example` · `src/services/dashboard.service.ts` · `src/server/session.ts`

**Delete:** `src/services/dashboard.preview.service.ts`

---

### Task 1: Wire Supabase env and create the first migration

Supabase provisioned `POSTGRES_PRISMA_URL` (pooled) and `POSTGRES_URL_NON_POOLING` (direct) into `.env.local`. `config/env.ts` requires `DATABASE_URL`, which does not exist — the app throws at import. Separately, `prisma.config.ts` calls `import "dotenv/config"`, which reads `.env` only and never `.env.local`, so migrations would target the old localhost URL.

Pooled connections cannot run DDL reliably; migrations need the direct URL.

**Files:**
- Modify: `src/config/env.ts`
- Modify: `prisma.config.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `env.DATABASE_URL` (pooled, runtime), `env.DIRECT_URL` (direct, migrations)

- [ ] **Step 1: Map Supabase variable names in `config/env.ts`**

Add `DIRECT_URL` to `serverEnvSchema` directly below `DATABASE_URL`:

```ts
  DATABASE_URL: z.string().url(),
  /** Unpooled connection. Migrations run DDL, which pgBouncer cannot proxy safely. */
  DIRECT_URL: z.string().url(),
```

Replace the first line of `loadServerEnv` so Supabase's names satisfy the contract without renaming anything in Vercel:

```ts
function loadServerEnv(): ServerEnv {
  // Supabase's Vercel integration injects POSTGRES_* names. Local docker-compose
  // sets DATABASE_URL directly, so an explicit value always wins.
  const source = {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL ?? process.env.POSTGRES_PRISMA_URL,
    DIRECT_URL:
      process.env.DIRECT_URL ??
      process.env.POSTGRES_URL_NON_POOLING ??
      process.env.DATABASE_URL ??
      process.env.POSTGRES_PRISMA_URL,
  };

  const parsed = serverEnvSchema.safeParse(source);
```

- [ ] **Step 2: Make the Prisma CLI read `.env.local`**

Replace the first two lines of `prisma.config.ts`:

```ts
import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// .env.local holds the Supabase values written by `vercel env pull`; it must load
// first so it overrides the local docker-compose defaults in .env.
config({ path: ".env.local" });
config({ path: ".env" });
```

And point the datasource at the direct connection:

```ts
  datasource: {
    url: process.env["POSTGRES_URL_NON_POOLING"] ?? process.env["DATABASE_URL"],
  },
```

- [ ] **Step 3: Document both variables in `.env.example`**

Under the `# --- Database ---` heading, replace the single `DATABASE_URL` line with:

```
# Pooled connection used at runtime. Supplied automatically by the Supabase
# integration as POSTGRES_PRISMA_URL; set explicitly only for local Postgres.
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/framecast
# Unpooled connection used by migrations. Supplied as POSTGRES_URL_NON_POOLING.
DIRECT_URL=postgresql://postgres:postgres@localhost:5432/framecast
```

- [ ] **Step 4: Create the initial migration**

Run: `pnpm db:migrate --name init`
Expected: `prisma/migrations/<timestamp>_init/migration.sql` is created and applied to Supabase. Verify every table exists:

Run: `pnpm db:studio` and confirm `user`, `video`, `script`, `prompt_template`, `provider_credential`, `provider_usage` are present.

- [ ] **Step 5: Lock the tables out of the Supabase Data API**

⚠️ **Security-critical. Do this before seeding — before any real data exists.**

Prisma creates its tables in the `public` schema. Supabase exposes `public` through PostgREST, reachable with `NEXT_PUBLIC_SUPABASE_ANON_KEY`, which is sent to every browser. Framecast authenticates with Better Auth and reads through Prisma as the database owner — it never uses PostgREST — so there are no RLS policies guarding these tables. Left alone, `provider_credential`, `account` (password hashes), `session`, and every video row are readable with a key that is public by design.

Prisma's connection is the table owner and bypasses RLS, so revoking the API roles costs the app nothing.

In the Supabase dashboard → **SQL Editor**, run:

```sql
-- Framecast reaches Postgres only through Prisma as the owner role.
-- PostgREST is unused, so the API roles get nothing, now or for future tables.
revoke usage on schema public from anon, authenticated;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

alter default privileges in schema public
  revoke all on tables from anon, authenticated;
alter default privileges in schema public
  revoke all on sequences from anon, authenticated;
```

Then confirm the lockdown from a terminal — substitute your values from `.env.local`:

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/provider_credential?select=*" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY"
```

Expected: `401` or `404` — **not** `200`. A `200` with a JSON array means the table is still exposed; do not continue until this returns an error.

Re-run the same curl after every future `pnpm db:migrate`, since new tables inherit default privileges.

- [ ] **Step 6: Seed the operator account**

Set `SEED_USER_EMAIL`, `SEED_USER_PASSWORD` (12+ characters — Better Auth enforces `minPasswordLength: 12`), and `SEED_USER_NAME` in `.env.local`, then:

Run: `pnpm db:seed`
Expected: `✓ Created operator account …`, `✓ Default settings ready`, `✓ Seeded 2 prompt templates`

- [ ] **Step 7: Verify sign-in against the real database**

Set `PREVIEW_MODE=false` in `.env.local`. Run `pnpm dev`, open `/sign-in`, sign in with the seeded credentials.
Expected: redirect to `/dashboard`, which renders with real (empty) data rather than fixtures.

- [ ] **Step 8: Commit**

```bash
git add src/config/env.ts prisma.config.ts .env.example prisma/migrations
git commit -m "feat: wire Supabase connection and create initial migration"
```

---

### Task 2: Test harness

The repo has no tests. Everything after this task is written test-first.

**Files:**
- Create: `vitest.config.ts`
- Create: `src/test/setup.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `pnpm test`, `pnpm test:watch`

- [ ] **Step 1: Install dependencies**

```bash
pnpm add -D vitest @vitejs/plugin-react vite-tsconfig-paths
```

- [ ] **Step 2: Create the `server-only` stub**

`src/test/server-only.stub.ts`:

```ts
// Intentionally empty. See the alias in vitest.config.ts.
export {};
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  resolve: {
    alias: {
      /**
       * The `server-only` package throws unless the bundler sets the
       * `react-server` export condition, which Next.js does and Vitest does
       * not. Every service imports it, so without this alias each service test
       * fails at import rather than on any behaviour under test.
       */
      "server-only": fileURLToPath(
        new URL("./src/test/server-only.stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["src/test/setup.ts"],
    // Service tests share one Postgres database; parallel files would race on
    // the same rows.
    fileParallelism: false,
  },
});
```

- [ ] **Step 4: Create `src/test/setup.ts`**

```ts
import { config } from "dotenv";

// Mirrors prisma.config.ts: .env.local wins over .env.
config({ path: ".env.local" });
config({ path: ".env" });

// Not NODE_ENV — Vitest sets that itself, and @types/node marks it read-only.
process.env.PREVIEW_MODE = "false";
```

- [ ] **Step 5: Add scripts to `package.json`**

```json
    "test": "vitest run",
    "test:watch": "vitest",
```

- [ ] **Step 6: Add a smoke test**

An empty suite verifies nothing, and Vitest exits 1 when it finds no tests —
`passWithNoTests` would only mask a broken glob later. `src/test/harness.test.ts`:

```ts
import { describe, expect, it } from "vitest";

describe("test harness", () => {
  it("resolves `server-only` to a no-op", async () => {
    await expect(import("server-only")).resolves.toBeDefined();
  });

  it("loads environment variables from .env.local", () => {
    const databaseUrl =
      process.env.DATABASE_URL ?? process.env.POSTGRES_PRISMA_URL;

    expect(databaseUrl).toBeTruthy();
  });

  it("forces PREVIEW_MODE off so tests never hit stubbed auth", () => {
    expect(process.env.PREVIEW_MODE).toBe("false");
  });
});
```

- [ ] **Step 7: Verify the harness runs**

Run: `pnpm test`
Expected: PASS — 3 tests, exit code 0.

- [ ] **Step 8: Commit**

```bash
git add vitest.config.ts src/test package.json pnpm-lock.yaml
git commit -m "chore: add vitest harness"
```

---

### Task 3: Credential encryption (`lib/crypto.ts`)

`CREDENTIAL_ENCRYPTION_KEY` is already validated as exactly 32 decoded bytes by `config/env.ts`.

**Files:**
- Create: `src/lib/crypto.ts`
- Test: `src/lib/crypto.test.ts`

**Interfaces:**
- Produces: `encryptSecret(plaintext: string): string`, `decryptSecret(payload: string): string`

- [ ] **Step 1: Write the failing test**

```ts
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

describe("crypto", () => {
  it("round-trips a secret", async () => {
    const { encryptSecret, decryptSecret } = await import("@/lib/crypto");
    expect(decryptSecret(encryptSecret("sk-test-123"))).toBe("sk-test-123");
  });

  it("produces a different ciphertext each time", async () => {
    const { encryptSecret } = await import("@/lib/crypto");
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("rejects tampered ciphertext", async () => {
    const { encryptSecret, decryptSecret } = await import("@/lib/crypto");
    const [iv, tag, data] = encryptSecret("sk-test-123").split(".");
    const flipped = Buffer.from(data, "base64");
    flipped[0] ^= 0xff;
    expect(() =>
      decryptSecret(`${iv}.${tag}.${flipped.toString("base64")}`),
    ).toThrow();
  });

  it("rejects a malformed payload", async () => {
    const { decryptSecret } = await import("@/lib/crypto");
    expect(() => decryptSecret("not-a-payload")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/crypto.test.ts`
Expected: FAIL — `Cannot find module '@/lib/crypto'`

- [ ] **Step 3: Implement `src/lib/crypto.ts`**

```ts
import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

import { env } from "@/config/env";
import { InternalError } from "@/lib/errors";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function key(): Buffer {
  return Buffer.from(env.CREDENTIAL_ENCRYPTION_KEY, "base64");
}

/** Returns `<iv>.<authTag>.<ciphertext>`, each segment base64. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return [iv, cipher.getAuthTag(), ciphertext]
    .map((part) => part.toString("base64"))
    .join(".");
}

/**
 * Any failure — tampering, a rotated key, a malformed payload — collapses to a
 * generic InternalError. Distinguishing them would leak whether a given
 * ciphertext is well-formed.
 */
export function decryptSecret(payload: string): string {
  const [iv, authTag, ciphertext] = payload.split(".");

  if (!iv || !authTag || !ciphertext) {
    throw new InternalError("Stored credential is unreadable.");
  }

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      key(),
      Buffer.from(iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(authTag, "base64"));

    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (cause) {
    throw new InternalError("Stored credential is unreadable.", { cause });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/crypto.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/crypto.ts src/lib/crypto.test.ts
git commit -m "feat: add AES-256-GCM credential encryption"
```

---

### Task 3b: Connect a YouTube channel

Added after the plan was written (operator decision, 2026-08-09). It sits here, immediately after `lib/crypto.ts`, because `Channel.accessToken` and `Channel.refreshToken` are plain `String` columns and a YouTube refresh token is **permanent upload access to the channel**. Connecting before the encryption module exists would write those credentials to disk in the clear.

This task connects and displays a channel. It does **not** upload — uploading is sub-project 3.

**Files:**
- Create: `src/lib/youtube-oauth.ts`, `src/services/channel.service.ts`
- Create: `src/app/api/youtube/connect/route.ts`, `src/app/api/youtube/callback/route.ts`
- Create: `src/app/(dashboard)/channels/page.tsx`, `src/features/channels/components/*`
- Create: `src/actions/channel.action.ts`
- Test: `src/services/channel.service.test.ts`

**Interfaces:**
- Consumes: `encryptSecret` / `decryptSecret` (Task 3)
- Produces: `channelService.{list,connect,disconnect,resolveAccessToken}`

**Why this is a separate flow from Better Auth's Google provider.** Signing in asks for identity only. This asks for `youtube.upload` and `youtube.readonly`, needs `access_type=offline` to obtain a refresh token, and stores that token against a `Channel` row rather than an `Account`. Merging the two would put upload permission on the sign-in consent screen for every login.

- [ ] **Step 1: Write the failing service test**

```ts
import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { channelService } from "@/services/channel.service";

let userId: string;

const TOKENS = {
  accessToken: "ya29.test-access-token",
  refreshToken: "1//test-refresh-token",
  expiresInSeconds: 3600,
  scopes: ["https://www.googleapis.com/auth/youtube.upload"],
};

beforeEach(async () => {
  await prisma.channel.deleteMany();
  userId = (await prisma.user.findFirstOrThrow()).id;
});

describe("channelService", () => {
  it("stores tokens encrypted, never in plaintext", async () => {
    await channelService.connect(userId, {
      youtubeChannelId: "UC_test",
      title: "Money Mechanics",
      ...TOKENS,
    });

    const row = await prisma.channel.findFirstOrThrow({ where: { userId } });
    expect(row.accessToken).not.toContain("ya29.test-access-token");
    expect(row.refreshToken).not.toContain("1//test-refresh-token");
  });

  it("round-trips the access token through resolveAccessToken", async () => {
    await channelService.connect(userId, {
      youtubeChannelId: "UC_test",
      title: "Money Mechanics",
      ...TOKENS,
    });

    const channel = await prisma.channel.findFirstOrThrow({ where: { userId } });
    expect(await channelService.resolveAccessToken(userId, channel.id)).toBe(
      "ya29.test-access-token",
    );
  });

  it("never leaks either token from list()", async () => {
    await channelService.connect(userId, {
      youtubeChannelId: "UC_test",
      title: "Money Mechanics",
      ...TOKENS,
    });

    const all = await channelService.list(userId);
    const serialised = JSON.stringify(all);
    expect(serialised).not.toContain("accessToken");
    expect(serialised).not.toContain("refreshToken");
  });

  it("reconnecting the same channel replaces the tokens rather than duplicating", async () => {
    await channelService.connect(userId, {
      youtubeChannelId: "UC_test",
      title: "Money Mechanics",
      ...TOKENS,
    });
    await channelService.connect(userId, {
      youtubeChannelId: "UC_test",
      title: "Money Mechanics (renamed)",
      ...TOKENS,
      accessToken: "ya29.second-token",
    });

    const all = await channelService.list(userId);
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe("Money Mechanics (renamed)");
  });

  it("disconnect removes the stored tokens", async () => {
    await channelService.connect(userId, {
      youtubeChannelId: "UC_test",
      title: "Money Mechanics",
      ...TOKENS,
    });
    const channel = await prisma.channel.findFirstOrThrow({ where: { userId } });

    await channelService.disconnect(userId, channel.id);

    expect(await channelService.list(userId)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/services/channel.service.test.ts`
Expected: FAIL — `Cannot find module '@/services/channel.service'`

- [ ] **Step 3: Create `src/lib/youtube-oauth.ts`**

```ts
import "server-only";

import { env } from "@/config/env";
import { ProviderError } from "@/lib/errors";

/**
 * Upload permission and read access to channel metadata. Deliberately not the
 * broad `youtube` scope — this app publishes and reports, it does not manage.
 */
export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];

export interface YouTubeTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scopes: string[];
}

export interface YouTubeChannelInfo {
  youtubeChannelId: string;
  title: string;
  handle: string | null;
  description: string | null;
  thumbnailUrl: string | null;
}

function redirectUri(): string {
  return `${env.BETTER_AUTH_URL}/api/youtube/callback`;
}

export function buildAuthUrl(state: string): string {
  if (!env.GOOGLE_CLIENT_ID) {
    throw new ProviderError("GEMINI", "Google OAuth is not configured.", false);
  }

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: YOUTUBE_SCOPES.join(" "),
    // Google returns a refresh token only with offline access, and only re-issues
    // one when consent is forced. Without both, reconnecting yields no refresh
    // token and unattended publishing breaks the moment the access token expires.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCode(code: string): Promise<YouTubeTokens> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    throw new ProviderError(
      "GEMINI",
      "Google rejected the authorisation code.",
      response.status >= 500,
    );
  }

  const body = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
  };

  if (!body.refresh_token) {
    throw new ProviderError(
      "GEMINI",
      "Google returned no refresh token. Revoke Framecast at myaccount.google.com/permissions and connect again.",
      false,
    );
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresInSeconds: body.expires_in,
    scopes: body.scope.split(" "),
  };
}

export async function fetchChannel(
  accessToken: string,
): Promise<YouTubeChannelInfo> {
  const response = await fetch(
    "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (!response.ok) {
    throw new ProviderError(
      "GEMINI",
      "Could not read the channel from YouTube.",
      response.status >= 500,
    );
  }

  const body = (await response.json()) as {
    items?: Array<{
      id: string;
      snippet: {
        title: string;
        customUrl?: string;
        description?: string;
        thumbnails?: { default?: { url?: string } };
      };
    }>;
  };

  const channel = body.items?.[0];

  if (!channel) {
    throw new ProviderError(
      "GEMINI",
      "That Google account has no YouTube channel.",
      false,
    );
  }

  return {
    youtubeChannelId: channel.id,
    title: channel.snippet.title,
    handle: channel.snippet.customUrl ?? null,
    description: channel.snippet.description ?? null,
    thumbnailUrl: channel.snippet.thumbnails?.default?.url ?? null,
  };
}
```

- [ ] **Step 4: Implement `src/services/channel.service.ts`**

Mirror `provider-credential.service.ts`: an explicit `SUMMARY_SELECT` that omits both token columns by construction, `encryptSecret` on write, `decryptSecret` only inside `resolveAccessToken`. `connect` upserts on the existing `@@unique([userId, youtubeChannelId])`. `disconnect` deletes the row outright rather than soft-deleting — leaving encrypted upload credentials behind after the operator asks to disconnect is not acceptable, and `Publication.channelId` cascades.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test src/services/channel.service.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 6: Build the routes and the page**

`/api/youtube/connect` requires a session, generates a random `state`, stores it in an httpOnly cookie, and redirects to `buildAuthUrl(state)`. `/api/youtube/callback` requires a session, compares `state` against the cookie and rejects on mismatch — without this the endpoint is open to CSRF, letting an attacker graft their own channel onto the operator's account — then exchanges the code, fetches the channel, calls `channelService.connect`, and redirects to `/channels`.

`/channels` lists connected channels with thumbnail, title, handle, and connection date, plus **Connect a channel** and **Disconnect**. Errors surface via the `?error=` pattern already used on the sign-in page.

- [ ] **Step 7: Commit**

```bash
git add src/lib/youtube-oauth.ts src/services/channel.service.ts src/services/channel.service.test.ts src/app/api/youtube src/app/\(dashboard\)/channels src/features/channels src/actions/channel.action.ts
git commit -m "feat: connect a YouTube channel with encrypted tokens"
```

---

### Task 4: Prompt rendering (`lib/prompt-template.ts`)

**Files:**
- Create: `src/lib/prompt-template.ts`
- Test: `src/lib/prompt-template.test.ts`

**Interfaces:**
- Produces: `extractVariables(content: string): string[]`, `renderTemplate(content, values, definitions): string`, `type VariableDefinition = { key: string; required: boolean; defaultValue: string | null }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import {
  extractVariables,
  renderTemplate,
  type VariableDefinition,
} from "@/lib/prompt-template";

const topic: VariableDefinition = {
  key: "topic",
  required: true,
  defaultValue: null,
};
const tone: VariableDefinition = {
  key: "tone",
  required: false,
  defaultValue: "neutral",
};

describe("extractVariables", () => {
  it("finds each placeholder once, in order", () => {
    expect(extractVariables("{{a}} then {{b}} then {{a}}")).toEqual(["a", "b"]);
  });

  it("returns an empty array when there are none", () => {
    expect(extractVariables("plain text")).toEqual([]);
  });
});

describe("renderTemplate", () => {
  it("substitutes supplied values", () => {
    expect(renderTemplate("About {{topic}}", { topic: "Enron" }, [topic])).toBe(
      "About Enron",
    );
  });

  it("falls back to defaultValue", () => {
    expect(renderTemplate("Tone: {{tone}}", {}, [tone])).toBe("Tone: neutral");
  });

  it("throws when a required variable has no value", () => {
    expect(() => renderTemplate("About {{topic}}", {}, [topic])).toThrow(
      /topic/,
    );
  });

  it("leaves unknown placeholders untouched so typos stay visible", () => {
    expect(renderTemplate("{{typo}}", {}, [])).toBe("{{typo}}");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/prompt-template.test.ts`
Expected: FAIL — `Cannot find module '@/lib/prompt-template'`

- [ ] **Step 3: Implement `src/lib/prompt-template.ts`**

```ts
import { ValidationError } from "@/lib/errors";

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export interface VariableDefinition {
  key: string;
  required: boolean;
  defaultValue: string | null;
}

export function extractVariables(content: string): string[] {
  const found = content.matchAll(PLACEHOLDER);

  return [...new Set([...found].map((match) => match[1]))];
}

/**
 * Unknown placeholders are deliberately left in place rather than emptied: a
 * mistyped `{{topc}}` should be obvious in the output, not silently produce a
 * subtly wrong prompt.
 */
export function renderTemplate(
  content: string,
  values: Record<string, string>,
  definitions: VariableDefinition[],
): string {
  const byKey = new Map(definitions.map((one) => [one.key, one]));
  const missing: string[] = [];

  const rendered = content.replace(PLACEHOLDER, (original, key: string) => {
    const supplied = values[key]?.trim();

    if (supplied) {
      return supplied;
    }

    const definition = byKey.get(key);

    if (!definition) {
      return original;
    }

    if (definition.defaultValue) {
      return definition.defaultValue;
    }

    if (definition.required) {
      missing.push(key);
    }

    return "";
  });

  if (missing.length > 0) {
    throw new ValidationError("Some required variables are missing.", {
      variables: missing,
    });
  }

  return rendered;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/prompt-template.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/prompt-template.ts src/lib/prompt-template.test.ts
git commit -m "feat: add prompt template rendering"
```

---

### Task 5: Cost calculation (`lib/cost.ts`)

`ProviderUsage.costUsd` is `Decimal(12,6)`. Cost is derived from token counts and a rate table so it is deterministic and testable, independent of what any gateway response happens to include.

**Files:**
- Create: `src/lib/cost.ts`
- Test: `src/lib/cost.test.ts`

**Interfaces:**
- Produces: `estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { estimateCostUsd } from "@/lib/cost";

describe("estimateCostUsd", () => {
  it("prices a known model per million tokens", () => {
    // 1M in at $3, 1M out at $15
    expect(estimateCostUsd("anthropic/claude-sonnet-5", 1_000_000, 1_000_000)).toBeCloseTo(18, 6);
  });

  it("scales linearly below a million tokens", () => {
    expect(estimateCostUsd("anthropic/claude-sonnet-5", 1_000, 2_000)).toBeCloseTo(0.033, 6);
  });

  it("returns 0 for an unknown model rather than guessing", () => {
    expect(estimateCostUsd("unknown/model", 1_000, 1_000)).toBe(0);
  });

  it("treats zero tokens as free", () => {
    expect(estimateCostUsd("anthropic/claude-sonnet-5", 0, 0)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/cost.test.ts`
Expected: FAIL — `Cannot find module '@/lib/cost'`

- [ ] **Step 3: Implement `src/lib/cost.ts`**

```ts
/**
 * USD per million tokens. Verify against current provider pricing when adding a
 * model — an unlisted model prices at 0 rather than guessing, so a missing entry
 * shows up as suspiciously free spend rather than a plausible wrong number.
 */
const RATES: Record<string, { input: number; output: number }> = {
  "anthropic/claude-sonnet-5": { input: 3, output: 15 },
  "anthropic/claude-opus-5": { input: 15, output: 75 },
  "anthropic/claude-haiku-4-5": { input: 1, output: 5 },
};

const PER_MILLION = 1_000_000;

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rate = RATES[model];

  if (!rate) {
    return 0;
  }

  return (
    (inputTokens * rate.input + outputTokens * rate.output) / PER_MILLION
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/cost.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/cost.ts src/lib/cost.test.ts
git commit -m "feat: add token cost estimation"
```

---

### Task 6: Provider interface and gateway implementation

**Files:**
- Create: `src/services/providers/types.ts`
- Create: `src/services/providers/gateway.provider.ts`
- Modify: `src/config/env.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `estimateCostUsd` (Task 5)
- Produces: `TextGenerationProvider`, `ScriptGenerationInput`, `ScriptGenerationResult`, `gatewayProvider`

- [ ] **Step 1: Install the AI SDK**

```bash
pnpm add ai
```

- [ ] **Step 2: Add gateway variables to `config/env.ts`**

Add to `serverEnvSchema`, after the Supabase block:

```ts
  /** Vercel AI Gateway. Optional: a stored ANTHROPIC credential takes precedence. */
  AI_GATEWAY_API_KEY: z.string().min(1).optional(),
  AI_SCRIPT_MODEL: z.string().min(1).default("anthropic/claude-sonnet-5"),
```

Add the same two keys to `.env.example` under a new `# --- AI ---` heading.

- [ ] **Step 3: Create `src/services/providers/types.ts`**

```ts
import type { AiProviderType } from "@/generated/prisma/enums";

export interface ScriptGenerationInput {
  prompt: string;
  /** Overrides env.AI_SCRIPT_MODEL. */
  model?: string;
  apiKey?: string;
}

export interface ScriptGenerationResult {
  content: string;
  model: string;
  provider: AiProviderType;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface TextGenerationProvider {
  generateScript(input: ScriptGenerationInput): Promise<ScriptGenerationResult>;
}
```

- [ ] **Step 4: Create `src/services/providers/gateway.provider.ts`**

```ts
import "server-only";

import { generateText } from "ai";

import { env } from "@/config/env";
import { estimateCostUsd } from "@/lib/cost";
import { ProviderError } from "@/lib/errors";
import type {
  ScriptGenerationInput,
  ScriptGenerationResult,
  TextGenerationProvider,
} from "@/services/providers/types";

/** 429 and 5xx are transient; everything else means the request itself is wrong. */
function isRetryable(error: unknown): boolean {
  const status = (error as { statusCode?: number })?.statusCode;

  return status === 429 || (status !== undefined && status >= 500);
}

/**
 * Routes plain `provider/model` strings through the Vercel AI Gateway, so adding
 * a model is a config change rather than a new dependency.
 */
export class GatewayProvider implements TextGenerationProvider {
  async generateScript(
    input: ScriptGenerationInput,
  ): Promise<ScriptGenerationResult> {
    const model = input.model ?? env.AI_SCRIPT_MODEL;
    const apiKey = input.apiKey ?? env.AI_GATEWAY_API_KEY;

    if (!apiKey) {
      throw new ProviderError(
        "ANTHROPIC",
        "No API key configured. Add one on the Providers page.",
        false,
      );
    }

    const startedAt = Date.now();

    try {
      const result = await generateText({
        model,
        prompt: input.prompt,
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      const inputTokens = result.usage.inputTokens ?? 0;
      const outputTokens = result.usage.outputTokens ?? 0;

      return {
        content: result.text,
        model,
        provider: "ANTHROPIC",
        inputTokens,
        outputTokens,
        costUsd: estimateCostUsd(model, inputTokens, outputTokens),
        latencyMs: Date.now() - startedAt,
      };
    } catch (cause) {
      throw new ProviderError(
        "ANTHROPIC",
        "The model provider failed to generate a script.",
        isRetryable(cause),
        { cause },
      );
    }
  }
}

export const gatewayProvider: TextGenerationProvider = new GatewayProvider();
```

- [ ] **Step 5: Verify it typechecks**

Run: `pnpm typecheck`
Expected: no errors. If `generateText` rejects the `headers` option or the `usage` field names differ in the installed AI SDK version, consult `node_modules/ai/dist/index.d.ts` and adjust — the surrounding contract (`ScriptGenerationResult`) must not change.

- [ ] **Step 6: Commit**

```bash
git add src/services/providers src/config/env.ts .env.example package.json pnpm-lock.yaml
git commit -m "feat: add AI Gateway text generation provider"
```

---

### Task 7: Credential vault service

**Files:**
- Create: `src/services/provider-credential.service.ts`
- Create: `src/schemas/provider.schema.ts`
- Test: `src/services/provider-credential.service.test.ts`

**Interfaces:**
- Consumes: `encryptSecret`/`decryptSecret` (Task 3)
- Produces: `providerCredentialService` with `list(userId)`, `upsert(userId, input)`, `remove(userId, provider)`, `resolveKey(userId, provider)`, `test(userId, provider)`
- Produces: `type CredentialSummary = { id, provider, label, keyLastFour, isActive, lastTestedAt, lastTestOk }` — note it has **no** `encryptedKey` field

- [ ] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { providerCredentialService } from "@/services/provider-credential.service";

let userId: string;

beforeEach(async () => {
  await prisma.providerCredential.deleteMany();
  const user = await prisma.user.findFirstOrThrow();
  userId = user.id;
});

describe("providerCredentialService", () => {
  it("stores a key encrypted and returns only the last four characters", async () => {
    const saved = await providerCredentialService.upsert(userId, {
      provider: "ELEVENLABS",
      apiKey: "sk-abcdefgh1234",
      label: "Main",
    });

    expect(saved.keyLastFour).toBe("1234");
    expect(saved).not.toHaveProperty("encryptedKey");

    const raw = await prisma.providerCredential.findFirstOrThrow({
      where: { userId, provider: "ELEVENLABS" },
    });
    expect(raw.encryptedKey).not.toContain("sk-abcdefgh1234");
  });

  it("never leaks encryptedKey from list()", async () => {
    await providerCredentialService.upsert(userId, {
      provider: "ELEVENLABS",
      apiKey: "sk-abcdefgh1234",
    });

    const all = await providerCredentialService.list(userId);
    expect(all).toHaveLength(1);
    expect(JSON.stringify(all)).not.toContain("encryptedKey");
  });

  it("round-trips the key through resolveKey", async () => {
    await providerCredentialService.upsert(userId, {
      provider: "ELEVENLABS",
      apiKey: "sk-abcdefgh1234",
    });

    expect(await providerCredentialService.resolveKey(userId, "ELEVENLABS")).toBe(
      "sk-abcdefgh1234",
    );
  });

  it("returns null from resolveKey when nothing is stored", async () => {
    expect(await providerCredentialService.resolveKey(userId, "OPENAI")).toBeNull();
  });

  it("replaces the key on a second upsert for the same provider", async () => {
    await providerCredentialService.upsert(userId, {
      provider: "ELEVENLABS",
      apiKey: "sk-first000000",
    });
    await providerCredentialService.upsert(userId, {
      provider: "ELEVENLABS",
      apiKey: "sk-second11111",
    });

    expect(await providerCredentialService.list(userId)).toHaveLength(1);
    expect(await providerCredentialService.resolveKey(userId, "ELEVENLABS")).toBe(
      "sk-second11111",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/services/provider-credential.service.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create `src/schemas/provider.schema.ts`**

```ts
import { z } from "zod";

export const aiProviderTypes = [
  "OPENAI",
  "ANTHROPIC",
  "GEMINI",
  "ELEVENLABS",
  "GOOGLE_VEO",
  "RUNWAY",
  "KLING",
  "REPLICATE",
  "PIKA",
  "LUMA",
] as const;

export const upsertCredentialSchema = z.object({
  provider: z.enum(aiProviderTypes),
  apiKey: z.string().min(8, "That key looks too short to be valid"),
  label: z.string().max(60).optional(),
});

export type UpsertCredentialInput = z.infer<typeof upsertCredentialSchema>;
```

- [ ] **Step 4: Implement `src/services/provider-credential.service.ts`**

```ts
import "server-only";

import type { AiProviderType } from "@/generated/prisma/enums";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";
import type { UpsertCredentialInput } from "@/schemas/provider.schema";

/**
 * Explicit select list, used by every read. `encryptedKey` is absent by
 * construction rather than by remembering to omit it.
 */
const SUMMARY_SELECT = {
  id: true,
  provider: true,
  label: true,
  keyLastFour: true,
  isActive: true,
  lastTestedAt: true,
  lastTestOk: true,
} as const;

export interface CredentialSummary {
  id: string;
  provider: AiProviderType;
  label: string | null;
  keyLastFour: string;
  isActive: boolean;
  lastTestedAt: Date | null;
  lastTestOk: boolean | null;
}

export class ProviderCredentialService {
  async list(userId: string): Promise<CredentialSummary[]> {
    return prisma.providerCredential.findMany({
      where: { userId, deletedAt: null },
      orderBy: { provider: "asc" },
      select: SUMMARY_SELECT,
    });
  }

  async upsert(
    userId: string,
    input: UpsertCredentialInput,
  ): Promise<CredentialSummary> {
    const data = {
      encryptedKey: encryptSecret(input.apiKey),
      keyLastFour: input.apiKey.slice(-4),
      label: input.label ?? null,
      isActive: true,
      deletedAt: null,
      // A replaced key invalidates any previous test result.
      lastTestedAt: null,
      lastTestOk: null,
    };

    return prisma.providerCredential.upsert({
      where: { userId_provider: { userId, provider: input.provider } },
      create: { ...data, userId, provider: input.provider },
      update: data,
      select: SUMMARY_SELECT,
    });
  }

  /** Soft delete, so ProviderUsage rows keep their credential reference. */
  async remove(userId: string, provider: AiProviderType): Promise<void> {
    await prisma.providerCredential.updateMany({
      where: { userId, provider, deletedAt: null },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  /** Returns the plaintext key, or null when the operator has not stored one. */
  async resolveKey(
    userId: string,
    provider: AiProviderType,
  ): Promise<string | null> {
    const credential = await prisma.providerCredential.findFirst({
      where: { userId, provider, deletedAt: null, isActive: true },
      select: { encryptedKey: true },
    });

    return credential ? decryptSecret(credential.encryptedKey) : null;
  }
}

export const providerCredentialService = new ProviderCredentialService();
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test src/services/provider-credential.service.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 6: Add the connection test**

Spec §6.1: the cheapest real call each provider offers, recording the outcome. Add to `ProviderCredentialService`, and import `gatewayProvider` from `@/services/providers/gateway.provider` at the top of the file:

```ts
  /**
   * A one-token completion is the cheapest call that still proves the key is
   * accepted upstream — validating the string's shape locally would pass for a
   * revoked key.
   */
  async test(userId: string, provider: AiProviderType): Promise<boolean> {
    const apiKey = await this.resolveKey(userId, provider);

    let ok = false;

    try {
      await gatewayProvider.generateScript({
        prompt: "Reply with the single word: ok",
        apiKey: apiKey ?? undefined,
      });
      ok = true;
    } catch {
      ok = false;
    }

    await prisma.providerCredential.updateMany({
      where: { userId, provider, deletedAt: null },
      data: { lastTestedAt: new Date(), lastTestOk: ok },
    });

    return ok;
  }
```

Add `testCredentialAction(provider)` to `src/actions/provider.action.ts` in Task 10, revalidating `/providers`.

- [ ] **Step 7: Verify the test method compiles**

Run: `pnpm typecheck`
Expected: no errors. Do not add a unit test for `test()` — it makes a real network call by design; it is verified by hand in Task 11 Step 1.

- [ ] **Step 8: Commit**

```bash
git add src/services/provider-credential.service.ts src/services/provider-credential.service.test.ts src/schemas/provider.schema.ts
git commit -m "feat: add provider credential vault"
```

---

### Task 8: Prompt template, project, and video services

Three small CRUD services. They are one task because none is independently reviewable — a video cannot exist without a project, and the video list is meaningless without templates to generate from.

**Files:**
- Create: `src/services/prompt-template.service.ts`
- Create: `src/services/project.service.ts`
- Create: `src/services/video.service.ts`
- Create: `src/schemas/{prompt,project,video}.schema.ts`
- Test: `src/services/video.service.test.ts`

**Interfaces:**
- Produces: `promptTemplateService.{list,get,create,update,remove,getDefault}`
- Produces: `projectService.{list,create,update,archive}`
- Produces: `videoService.{list,get,create,approveScript}`

- [ ] **Step 1: Write the failing test for the state machine**

```ts
import { beforeEach, describe, expect, it } from "vitest";

import { ConflictError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { projectService } from "@/services/project.service";
import { videoService } from "@/services/video.service";

let userId: string;
let projectId: string;

beforeEach(async () => {
  await prisma.video.deleteMany();
  await prisma.project.deleteMany();
  const user = await prisma.user.findFirstOrThrow();
  userId = user.id;
  projectId = (await projectService.create(userId, { name: "Money Mechanics" })).id;
});

describe("videoService", () => {
  it("creates a video in DRAFT", async () => {
    const video = await videoService.create(userId, {
      projectId,
      title: "How inflation actually works",
      topic: "inflation",
    });

    expect(video.status).toBe("DRAFT");
  });

  it("refuses approval while there is no script", async () => {
    const video = await videoService.create(userId, {
      projectId,
      title: "No script yet",
      topic: "x",
    });

    await expect(videoService.approveScript(userId, video.id)).rejects.toThrow(
      ConflictError,
    );
  });

  it("hides another user's videos", async () => {
    const video = await videoService.create(userId, {
      projectId,
      title: "Mine",
      topic: "x",
    });

    await expect(
      videoService.get("00000000-0000-4000-8000-000000000001", video.id),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/services/video.service.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create the Zod schemas**

`src/schemas/project.schema.ts`:

```ts
import { z } from "zod";

export const createProjectSchema = z.object({
  name: z.string().min(1, "Name is required").max(80),
  description: z.string().max(500).optional(),
  channelId: z.string().uuid().optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
```

`src/schemas/video.schema.ts`:

```ts
import { z } from "zod";

export const createVideoSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1, "Title is required").max(120),
  topic: z.string().min(3, "Give the topic a few more words").max(300),
});

export type CreateVideoInput = z.infer<typeof createVideoSchema>;
```

`src/schemas/prompt.schema.ts`:

```ts
import { z } from "zod";

export const promptCategories = [
  "SCRIPT",
  "THUMBNAIL",
  "SCENE",
  "TITLE",
  "DESCRIPTION",
  "TAGS",
] as const;

export const promptVariableSchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9_]+$/, "Letters, numbers and _ only"),
  label: z.string().min(1).max(60),
  defaultValue: z.string().max(200).optional(),
  required: z.boolean().default(false),
});

export const upsertPromptSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(300).optional(),
  category: z.enum(promptCategories),
  content: z.string().min(10, "A prompt needs more than a few words"),
  isDefault: z.boolean().default(false),
  variables: z.array(promptVariableSchema).max(20),
});

export type UpsertPromptInput = z.infer<typeof upsertPromptSchema>;
```

- [ ] **Step 4: Implement `src/services/project.service.ts`**

```ts
import "server-only";

import { NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import type { CreateProjectInput } from "@/schemas/project.schema";

export class ProjectService {
  async list(userId: string) {
    return prisma.project.findMany({
      where: { userId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      include: { _count: { select: { videos: true } } },
    });
  }

  async create(userId: string, input: CreateProjectInput) {
    return prisma.project.create({
      data: {
        userId,
        name: input.name,
        description: input.description ?? null,
        channelId: input.channelId ?? null,
      },
    });
  }

  async update(userId: string, id: string, input: CreateProjectInput) {
    const { count } = await prisma.project.updateMany({
      where: { id, userId, deletedAt: null },
      data: {
        name: input.name,
        description: input.description ?? null,
        channelId: input.channelId ?? null,
      },
    });

    if (count === 0) {
      throw new NotFoundError("Project");
    }
  }

  async archive(userId: string, id: string) {
    const { count } = await prisma.project.updateMany({
      where: { id, userId, deletedAt: null },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });

    if (count === 0) {
      throw new NotFoundError("Project");
    }
  }
}

export const projectService = new ProjectService();
```

- [ ] **Step 5: Implement `src/services/video.service.ts`**

```ts
import "server-only";

import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import type { CreateVideoInput } from "@/schemas/video.schema";

export class VideoService {
  async list(userId: string) {
    return prisma.video.findMany({
      where: { userId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        title: true,
        topic: true,
        status: true,
        updatedAt: true,
        project: { select: { id: true, name: true } },
      },
    });
  }

  async get(userId: string, id: string) {
    const video = await prisma.video.findFirst({
      where: { id, userId, deletedAt: null },
      include: {
        project: { select: { id: true, name: true } },
        script: {
          include: {
            versions: { orderBy: { version: "desc" } },
            activeVersion: true,
          },
        },
        statusEvents: { orderBy: { createdAt: "desc" }, take: 10 },
      },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    return video;
  }

  async create(userId: string, input: CreateVideoInput) {
    const project = await prisma.project.findFirst({
      where: { id: input.projectId, userId, deletedAt: null },
      select: { id: true },
    });

    if (!project) {
      throw new NotFoundError("Project");
    }

    return prisma.$transaction(async (tx) => {
      const video = await tx.video.create({
        data: {
          userId,
          projectId: project.id,
          title: input.title,
          topic: input.topic,
        },
      });

      await tx.videoStatusEvent.create({
        data: { videoId: video.id, to: "DRAFT", message: "Video created" },
      });

      return video;
    });
  }

  /**
   * Gate 1. Approving costs nothing yet — it only makes the video eligible for
   * the expensive stages, which is precisely why the gate sits here.
   */
  async approveScript(userId: string, id: string) {
    const video = await prisma.video.findFirst({
      where: { id, userId, deletedAt: null },
      select: {
        id: true,
        status: true,
        script: { select: { activeVersion: { select: { content: true } } } },
      },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    if (video.status !== "DRAFT") {
      throw new ConflictError(
        `Only draft videos can be approved. This one is ${video.status.toLowerCase()}.`,
      );
    }

    if (!video.script?.activeVersion?.content.trim()) {
      throw new ConflictError("Generate a script before approving.");
    }

    await prisma.$transaction([
      prisma.video.update({ where: { id }, data: { status: "QUEUED" } }),
      prisma.videoStatusEvent.create({
        data: {
          videoId: id,
          from: "DRAFT",
          to: "QUEUED",
          message: "Script approved by operator",
        },
      }),
    ]);
  }
}

export const videoService = new VideoService();
```

- [ ] **Step 6: Implement `src/services/prompt-template.service.ts`**

```ts
import "server-only";

import type { PromptCategory } from "@/generated/prisma/enums";
import { NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import type { UpsertPromptInput } from "@/schemas/prompt.schema";

export class PromptTemplateService {
  async list(userId: string) {
    return prisma.promptTemplate.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ category: "asc" }, { name: "asc" }],
      include: { variables: true },
    });
  }

  async get(userId: string, id: string) {
    const template = await prisma.promptTemplate.findFirst({
      where: { id, userId, deletedAt: null },
      include: { variables: true },
    });

    if (!template) {
      throw new NotFoundError("Prompt template");
    }

    return template;
  }

  async getDefault(userId: string, category: PromptCategory) {
    const template = await prisma.promptTemplate.findFirst({
      where: { userId, category, isDefault: true, deletedAt: null },
      include: { variables: true },
    });

    if (!template) {
      throw new NotFoundError(`Default ${category.toLowerCase()} prompt`);
    }

    return template;
  }

  async create(userId: string, input: UpsertPromptInput) {
    return prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.promptTemplate.updateMany({
          where: { userId, category: input.category, isDefault: true },
          data: { isDefault: false },
        });
      }

      return tx.promptTemplate.create({
        data: {
          userId,
          name: input.name,
          description: input.description ?? null,
          category: input.category,
          content: input.content,
          isDefault: input.isDefault,
          variables: {
            create: input.variables.map((one) => ({
              key: one.key,
              label: one.label,
              defaultValue: one.defaultValue ?? null,
              required: one.required,
            })),
          },
        },
        include: { variables: true },
      });
    });
  }

  async update(userId: string, id: string, input: UpsertPromptInput) {
    await this.get(userId, id);

    return prisma.$transaction(async (tx) => {
      if (input.isDefault) {
        await tx.promptTemplate.updateMany({
          where: { userId, category: input.category, isDefault: true },
          data: { isDefault: false },
        });
      }

      // Variables are replaced wholesale: they have no identity of their own and
      // diffing them would add complexity with no user-visible benefit.
      await tx.promptVariable.deleteMany({ where: { promptTemplateId: id } });

      return tx.promptTemplate.update({
        where: { id },
        data: {
          name: input.name,
          description: input.description ?? null,
          category: input.category,
          content: input.content,
          isDefault: input.isDefault,
          variables: {
            create: input.variables.map((one) => ({
              key: one.key,
              label: one.label,
              defaultValue: one.defaultValue ?? null,
              required: one.required,
            })),
          },
        },
        include: { variables: true },
      });
    });
  }

  async remove(userId: string, id: string) {
    await this.get(userId, id);
    await prisma.promptTemplate.update({
      where: { id },
      data: { deletedAt: new Date(), isDefault: false },
    });
  }
}

export const promptTemplateService = new PromptTemplateService();
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm test src/services/video.service.test.ts && pnpm typecheck`
Expected: PASS — 3 tests, no type errors

- [ ] **Step 8: Commit**

```bash
git add src/services/project.service.ts src/services/video.service.ts src/services/prompt-template.service.ts src/services/video.service.test.ts src/schemas
git commit -m "feat: add project, video, and prompt template services"
```

---

### Task 9: Script generation service

**Files:**
- Create: `src/services/script.service.ts`
- Test: `src/services/script.service.test.ts`

**Interfaces:**
- Consumes: `gatewayProvider` (Task 6), `providerCredentialService.resolveKey` (Task 7), `promptTemplateService.getDefault` (Task 8), `renderTemplate` (Task 4)
- Produces: `scriptService.generate(userId, videoId, input)`, `scriptService.setActiveVersion(userId, videoId, versionId)`, `scriptService.saveEdit(userId, videoId, content)`

- [ ] **Step 1: Write the failing test**

The provider is injected so the test never makes a network call.

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { projectService } from "@/services/project.service";
import type { TextGenerationProvider } from "@/services/providers/types";
import { ScriptService } from "@/services/script.service";
import { videoService } from "@/services/video.service";

const fakeProvider: TextGenerationProvider = {
  generateScript: vi.fn(async () => ({
    content: "Hook. Body. Sources on screen.",
    model: "anthropic/claude-sonnet-5",
    provider: "ANTHROPIC" as const,
    inputTokens: 100,
    outputTokens: 400,
    costUsd: 0.0063,
    latencyMs: 1200,
  })),
};

let userId: string;
let videoId: string;
let service: ScriptService;

beforeEach(async () => {
  await prisma.video.deleteMany();
  await prisma.project.deleteMany();
  await prisma.providerUsage.deleteMany();
  const user = await prisma.user.findFirstOrThrow();
  userId = user.id;
  const project = await projectService.create(userId, { name: "Money Mechanics" });
  videoId = (
    await videoService.create(userId, {
      projectId: project.id,
      title: "How inflation actually works",
      topic: "inflation",
    })
  ).id;
  service = new ScriptService(fakeProvider);
});

describe("scriptService.generate", () => {
  it("stores version 1 and makes it active", async () => {
    const version = await service.generate(userId, videoId, {});

    expect(version.version).toBe(1);
    expect(version.wordCount).toBe(5);

    const script = await prisma.script.findUniqueOrThrow({ where: { videoId } });
    expect(script.activeVersionId).toBe(version.id);
  });

  it("increments the version on regeneration", async () => {
    await service.generate(userId, videoId, {});
    const second = await service.generate(userId, videoId, {});

    expect(second.version).toBe(2);
  });

  it("records a ProviderUsage row with the cost", async () => {
    await service.generate(userId, videoId, {});

    const usage = await prisma.providerUsage.findFirstOrThrow();
    expect(usage.succeeded).toBe(true);
    expect(Number(usage.costUsd)).toBeCloseTo(0.0063, 6);
  });

  it("records a failed ProviderUsage row when the provider throws", async () => {
    const failing = new ScriptService({
      generateScript: vi.fn(async () => {
        throw new Error("upstream down");
      }),
    });

    await expect(failing.generate(userId, videoId, {})).rejects.toThrow();

    const usage = await prisma.providerUsage.findFirstOrThrow();
    expect(usage.succeeded).toBe(false);
  });

  it("retains the rendered prompt for reproducibility", async () => {
    const version = await service.generate(userId, videoId, {});

    expect(version.prompt).toContain("inflation");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/services/script.service.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/services/script.service.ts`**

```ts
import "server-only";

import { ConflictError, NotFoundError } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { renderTemplate } from "@/lib/prompt-template";
import { promptTemplateService } from "@/services/prompt-template.service";
import { providerCredentialService } from "@/services/provider-credential.service";
import { gatewayProvider } from "@/services/providers/gateway.provider";
import type { TextGenerationProvider } from "@/services/providers/types";

export interface GenerateScriptInput {
  templateId?: string;
  variables?: Record<string, string>;
}

function countWords(content: string): number {
  return content.trim().split(/\s+/).filter(Boolean).length;
}

export class ScriptService {
  constructor(private readonly provider: TextGenerationProvider = gatewayProvider) {}

  async generate(
    userId: string,
    videoId: string,
    input: GenerateScriptInput,
  ) {
    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: { id: true, status: true, title: true, topic: true },
    });

    if (!video) {
      throw new NotFoundError("Video");
    }

    if (video.status !== "DRAFT") {
      throw new ConflictError(
        "A script can only be generated while the video is still a draft.",
      );
    }

    const template = input.templateId
      ? await promptTemplateService.get(userId, input.templateId)
      : await promptTemplateService.getDefault(userId, "SCRIPT");

    // The topic is always available as {{topic}} without the operator retyping it.
    const prompt = renderTemplate(
      template.content,
      { topic: video.topic ?? video.title, ...input.variables },
      template.variables,
    );

    const apiKey =
      (await providerCredentialService.resolveKey(userId, "ANTHROPIC")) ??
      undefined;

    try {
      const result = await this.provider.generateScript({ prompt, apiKey });

      return await prisma.$transaction(async (tx) => {
        const script = await tx.script.upsert({
          where: { videoId },
          create: { videoId },
          update: {},
        });

        const previous = await tx.scriptVersion.findFirst({
          where: { scriptId: script.id },
          orderBy: { version: "desc" },
          select: { version: true },
        });

        const version = await tx.scriptVersion.create({
          data: {
            scriptId: script.id,
            version: (previous?.version ?? 0) + 1,
            content: result.content,
            wordCount: countWords(result.content),
            prompt,
            model: result.model,
            provider: result.provider,
          },
        });

        await tx.script.update({
          where: { id: script.id },
          data: { activeVersionId: version.id },
        });

        await tx.providerUsage.create({
          data: {
            provider: result.provider,
            operation: "script.generate",
            model: result.model,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            costUsd: result.costUsd,
            latencyMs: result.latencyMs,
            succeeded: true,
          },
        });

        await tx.activityLog.create({
          data: {
            userId,
            action: "script.generate",
            entityType: "Video",
            entityId: videoId,
            message: `Generated script v${version.version} (${version.wordCount} words)`,
          },
        });

        return version;
      });
    } catch (error) {
      // Wasted spend still has to appear on the cost dashboard.
      await prisma.providerUsage.create({
        data: {
          provider: "ANTHROPIC",
          operation: "script.generate",
          succeeded: false,
        },
      });

      throw error;
    }
  }

  /** Operator edits append a new version rather than mutating the old one. */
  async saveEdit(userId: string, videoId: string, content: string) {
    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: { id: true, script: { select: { id: true } } },
    });

    if (!video?.script) {
      throw new NotFoundError("Script");
    }

    const scriptId = video.script.id;

    return prisma.$transaction(async (tx) => {
      const previous = await tx.scriptVersion.findFirst({
        where: { scriptId },
        orderBy: { version: "desc" },
        select: { version: true },
      });

      const version = await tx.scriptVersion.create({
        data: {
          scriptId,
          version: (previous?.version ?? 0) + 1,
          content,
          wordCount: countWords(content),
        },
      });

      await tx.script.update({
        where: { id: scriptId },
        data: { activeVersionId: version.id },
      });

      return version;
    });
  }

  async setActiveVersion(userId: string, videoId: string, versionId: string) {
    const video = await prisma.video.findFirst({
      where: { id: videoId, userId, deletedAt: null },
      select: { script: { select: { id: true } } },
    });

    if (!video?.script) {
      throw new NotFoundError("Script");
    }

    const version = await prisma.scriptVersion.findFirst({
      where: { id: versionId, scriptId: video.script.id },
      select: { id: true },
    });

    if (!version) {
      throw new NotFoundError("Script version");
    }

    await prisma.script.update({
      where: { id: video.script.id },
      data: { activeVersionId: version.id },
    });
  }
}

export const scriptService = new ScriptService();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/services/script.service.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/services/script.service.ts src/services/script.service.test.ts
git commit -m "feat: add script generation with versioning and usage tracking"
```

---

### Task 10: Server actions

Actions stay thin: validate with Zod, call one service, revalidate. All error mapping goes through `toSerializedError`.

**Files:**
- Create: `src/actions/provider.action.ts`, `prompt.action.ts`, `project.action.ts`, `video.action.ts`, `script.action.ts`
- Create: `src/actions/action-result.ts`

**Interfaces:**
- Produces: `type ActionResult<T> = { ok: true; data: T } | { ok: false; error: SerializedError }`

- [ ] **Step 1: Create `src/actions/action-result.ts`**

```ts
import { type SerializedError, toSerializedError } from "@/lib/errors";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: SerializedError };

/**
 * Single funnel for every server action, so a thrown driver message can never
 * reach the browser by someone forgetting a try/catch.
 */
export async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    return { ok: false, error: toSerializedError(error) };
  }
}
```

- [ ] **Step 2: Create `src/actions/video.action.ts`**

```ts
"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import { createVideoSchema } from "@/schemas/video.schema";
import { requireSession } from "@/server/session";
import { videoService } from "@/services/video.service";

export async function createVideoAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = createVideoSchema.parse(input);
    const video = await videoService.create(session.user.id, parsed);

    revalidatePath("/videos");

    return { id: video.id };
  });
}

export async function approveScriptAction(
  videoId: string,
): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    await videoService.approveScript(session.user.id, videoId);

    revalidatePath("/videos");
    revalidatePath(`/videos/${videoId}`);

    return null;
  });
}
```

- [ ] **Step 3: Create `src/actions/provider.action.ts`**

```ts
"use server";

import { revalidatePath } from "next/cache";

import { run, type ActionResult } from "@/actions/action-result";
import type { AiProviderType } from "@/generated/prisma/enums";
import { upsertCredentialSchema } from "@/schemas/provider.schema";
import { requireSession } from "@/server/session";
import {
  providerCredentialService,
  type CredentialSummary,
} from "@/services/provider-credential.service";

export async function upsertCredentialAction(
  input: unknown,
): Promise<ActionResult<CredentialSummary>> {
  return run(async () => {
    const session = await requireSession();
    const parsed = upsertCredentialSchema.parse(input);
    const saved = await providerCredentialService.upsert(session.user.id, parsed);

    revalidatePath("/providers");

    return saved;
  });
}

export async function removeCredentialAction(
  provider: AiProviderType,
): Promise<ActionResult<null>> {
  return run(async () => {
    const session = await requireSession();
    await providerCredentialService.remove(session.user.id, provider);

    revalidatePath("/providers");

    return null;
  });
}

export async function testCredentialAction(
  provider: AiProviderType,
): Promise<ActionResult<{ ok: boolean }>> {
  return run(async () => {
    const session = await requireSession();
    const ok = await providerCredentialService.test(session.user.id, provider);

    revalidatePath("/providers");

    return { ok };
  });
}
```

- [ ] **Step 4: Create the remaining three action files**

Each follows the identical five-line body shape as above — `"use server"`, `run(...)`, `requireSession()`, `schema.parse(input)`, one service call, `revalidatePath`. Write them out in full; do not abbreviate:

- `prompt.action.ts` → `createPromptAction(input)`, `updatePromptAction(id, input)`, `removePromptAction(id)` — validate with `upsertPromptSchema`, call `promptTemplateService.{create,update,remove}`, revalidate `/prompts`
- `project.action.ts` → `createProjectAction(input)`, `updateProjectAction(id, input)`, `archiveProjectAction(id)` — validate with `createProjectSchema`, call `projectService.{create,update,archive}`, revalidate `/projects`
- `script.action.ts` → `generateScriptAction(videoId, input)`, `saveScriptEditAction(videoId, content)`, `setActiveVersionAction(videoId, versionId)` — call `scriptService.{generate,saveEdit,setActiveVersion}`, revalidate `` `/videos/${videoId}` ``

- [ ] **Step 5: Verify**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/actions
git commit -m "feat: add server actions for providers, prompts, projects, videos, scripts"
```

---

### Task 11: Route surfaces

Five routes under `src/app/(dashboard)/`. All are already declared in `config/navigation.ts` — no navigation changes are needed. Follow the existing composition: a server component page fetches through a service and passes plain data into feature components under `src/features/<name>/components/`. Reuse `PageHeader`, `EmptyState`, `StatCard`, and `VideoStatusBadge`.

**Files:**
- Create: `src/app/(dashboard)/providers/page.tsx`, `prompts/page.tsx`, `projects/page.tsx`, `videos/page.tsx`, `videos/[id]/page.tsx`
- Create: `src/features/{providers,prompts,projects,videos}/components/*.tsx`

- [ ] **Step 1: Build `/providers`**

Server component calls `providerCredentialService.list(userId)`. Renders one row per `AiProviderType` — configured rows show `•••• {keyLastFour}` plus `lastTestedAt`; unconfigured rows show an "Add key" button. A dialog form (`react-hook-form` + `zodResolver(upsertCredentialSchema)`) calls `upsertCredentialAction`. Each configured row also gets a **Test** button wired to `testCredentialAction`, showing a `sonner` toast and refreshing `lastTestedAt` / `lastTestOk`. Below the table, a spend summary aggregates `ProviderUsage.costUsd` for the last 30 days.

Verify: add a key, confirm it renders as `•••• 1234`, reload, confirm it persists, and confirm the full key appears nowhere in the page source.

- [ ] **Step 2: Build `/prompts`**

Tabs per `PromptCategory`. Each template shows name, description, a `Default` badge, and a variable list. The editor is a textarea plus a variable table (key, label, default, required). On save, call `extractVariables(content)` and warn when a placeholder in the content has no matching variable row.

Verify: edit the seeded `Default script` template, save, reload, confirm the change persisted.

- [ ] **Step 3: Build `/projects`**

Table of projects with video counts and a create dialog. Archive via `archiveProjectAction`.

Verify: create `Money Mechanics`; it appears with 0 videos.

- [ ] **Step 4: Build `/videos`**

Table with a status filter (`VideoStatus`), using the existing `VideoStatusBadge`. A "New video" dialog takes project, title, and topic.

Verify: create a video; it appears as `DRAFT`.

- [ ] **Step 5: Build `/videos/[id]` — the Gate 1 screen**

Three regions:
1. Header — title, status badge, project, estimated duration (`wordCount / 150` minutes).
2. Script panel — active version in an editable textarea; **Generate**, **Regenerate**, **Save edit** buttons.
3. Sidebar — version history (click to make active) and the last 10 `statusEvents`.

The **Approve script** button calls `approveScriptAction`, is disabled unless status is `DRAFT` with a non-empty active version, and shows a `sonner` toast on both outcomes.

Verify: generate a script, edit it, approve it, and confirm the status becomes `QUEUED` and a new `VideoStatusEvent` appears.

- [ ] **Step 6: Commit**

```bash
git add src/app src/features
git commit -m "feat: add providers, prompts, projects, and videos surfaces"
```

---

### Task 12: Retire PREVIEW_MODE and update the seeded prompt

`PREVIEW_MODE` stubs authentication. With a real database in place it is now only a standing risk — `config/env.ts` refuses it in production, but nothing stops it in a preview deployment.

The seeded SCRIPT template must also carry the Money Mechanics guardrails from the spec.

**Files:**
- Modify: `src/config/env.ts`, `src/server/session.ts`, `src/services/dashboard.service.ts`, `.env.example`, `prisma/seed.ts`
- Delete: `src/services/dashboard.preview.service.ts`

- [ ] **Step 1: Remove the flag from `config/env.ts`**

Delete `PREVIEW_MODE` from `serverEnvSchema`, delete the `booleanFlag` helper, delete the production guard block inside `loadServerEnv`, and delete the `isPreviewMode` export.

- [ ] **Step 2: Remove the stub session**

In `src/server/session.ts`, delete `PREVIEW_USER`, the `isPreviewMode` import, and the `if (isPreviewMode)` branch in `requireUser`.

- [ ] **Step 3: Bind the real dashboard service**

In `src/services/dashboard.service.ts`, delete the `isPreviewMode` and `PreviewDashboardService` imports and replace the final export:

```ts
export const dashboardService: DashboardReader = new DashboardService();
```

Then: `rm src/services/dashboard.preview.service.ts`

- [ ] **Step 4: Remove `PREVIEW_MODE` from `.env.example`**

Delete the flag and its four comment lines.

- [ ] **Step 5: Replace the seeded SCRIPT template**

In `prisma/seed.ts`, replace the `Default script` entry's `content` with the guardrailed version:

```ts
      content:
        "You are writing a {{duration}}-minute narration script for Money Mechanics, " +
        "a YouTube channel that explains how business and money actually work.\n\n" +
        "Topic: {{topic}}\n" +
        "Audience: {{audience}}\n" +
        "Tone: {{tone}}\n\n" +
        "Rules — these are not stylistic preferences:\n" +
        "- Explain how something works or what happened. Never give financial advice.\n" +
        "- Never recommend buying or selling any asset, stock, or cryptocurrency.\n" +
        "- Never predict a price or promise a return.\n" +
        "- Every factual claim must name its source inline, e.g. (SEC filing, 2001).\n" +
        "- End with a SOURCES section listing each source on its own line.\n\n" +
        "Structure: a hook in the first 5 seconds that poses the question, " +
        "then the explanation in clear beats, then a one-line close. " +
        "Write spoken prose only — no scene directions, no speaker labels.",
```

- [ ] **Step 6: Verify the whole surface still works**

```bash
pnpm typecheck && pnpm lint && pnpm test
```
Expected: no type errors, no lint errors, all tests pass.

Then confirm `PREVIEW_MODE` is gone entirely:

Run: `grep -rn "PREVIEW_MODE\|isPreviewMode\|preview.service" src/ .env.example`
Expected: no matches.

Finally run `pnpm db:seed` again and `pnpm dev`, sign in, and walk the full path: create project → create video → generate script → edit → approve → status is `QUEUED`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: remove PREVIEW_MODE and add channel guardrails to seeded prompt"
```

---

## Done when

- [ ] The Data API curl check returns 401/404, not 200 — no table is readable with the public anon key
- [ ] Operator signs in against Supabase, not a stub
- [ ] A key can be stored, shown as `•••• 1234`, and never leaks in full
- [ ] The seeded SCRIPT prompt forbids advice and requires sources
- [ ] Topic → script works end to end and costs under $0.10
- [ ] Regenerating creates v2; any version can be made active again
- [ ] Every generation writes a `ProviderUsage` row, including failures
- [ ] Approving a script moves the video to `QUEUED` and appends a `VideoStatusEvent`
- [ ] `PREVIEW_MODE` no longer exists anywhere in the codebase
- [ ] `pnpm typecheck && pnpm lint && pnpm test` all pass
