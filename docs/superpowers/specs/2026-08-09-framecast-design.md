# Framecast — Design

**Date:** 2026-08-09
**Status:** Approved for planning
**Scope:** System design for the whole product, plus a detailed spec for Sub-project 1.

---

## 1. Goal

**Framecast** is a single-operator pipeline that turns a topic into a published YouTube
video with two human approval gates and no other manual steps.

Its first channel is **Money Mechanics** — faceless finance and business explainers.

> The product may not be named "… YouTube …". Google's brand guidelines forbid using the
> YouTube trademark in third-party product names, which would block the SaaS path and
> invite a takedown. Hence Framecast.

The operator runs one faceless finance/business channel with it. The application is a
private tool first; every table is already `userId`-scoped, so opening it to paying
users later is a policy change, not a migration.

**Success criteria**

| Horizon | Measure |
|---|---|
| Sub-project 1 done | Operator enters a topic, gets a usable script, approves it — in the app, costing under $0.10 |
| Sub-project 3 done | A topic becomes a published YouTube video with no manual file handling |
| Month 6 | 1,000 subscribers and 4,000 watch hours; monetization applied for |
| Month 9 | Ad revenue exceeds running cost (~$70/month) |

**Explicit non-goals for now:** multi-user billing, team roles, a public marketing site,
mobile apps, AI-generated video footage, live streaming.

---

## 2. Content strategy

### Format

Faceless long-form video, 8–10 minutes: AI-written script, AI voice-over, stock footage,
burned-in captions. Three Shorts (30–60s vertical) are cut from each finished long video.

One production, two outputs. Shorts are **not** a second pipeline — they are an extra
FFmpeg pass over the rendered long video.

### Why this split

| | Long video | Shorts |
|---|---|---|
| RPM (per 1,000 views) | $10–25 (finance) | ~$0.10 |
| Role | Earns the revenue | Drives discovery and subscribers |

Shorts pay roughly 50–100× less per view. They exist to reach the 1,000-subscriber
threshold and feed the long videos, not to earn.

### Niche and guardrails

Finance and business, restricted to **explanatory and historical content**:

- Business case studies — company rises and collapses
- How financial systems work — inflation, interest, indexes
- Money psychology and habits
- History of markets, companies, and crises

**Prohibited by prompt design and by review:** stock or crypto picks, price predictions,
promised returns, any personal financial advice.

Finance is a "Your Money or Your Life" category on YouTube and receives additional
scrutiny. Combined with YouTube's inauthentic-content policy, an unsupervised automated
finance channel is the highest-risk configuration on the platform. The guardrails above
plus the permanent Gate 2 review are what make this viable. **Gate 2 is a product
requirement, not a convenience.**

Every script must cite its sources; sources are rendered on screen and listed in the
video description.

### Audience targeting

RPM is set by where the **viewers** are, not where the operator is. The operator is in
Egypt; the audience target is the United States. That is achieved through content, never
through misrepresenting location:

- American English voice (ElevenLabs)
- Channel language set to English (US)
- US-centric subjects — American companies, the dollar, US markets
- Publishing timed to the US evening watch window

AdSense registration uses the operator's real legal name, real Egyptian address, and a
W-8BEN filing. Misstating country in AdSense causes termination and forfeited earnings,
and yields no RPM benefit whatsoever.

### Unit economics

Per package — one long video plus three Shorts:

| Item | Cost |
|---|---|
| Script (Claude, ~1,200 words) | ~$0.05 |
| Voice-over (ElevenLabs) | $0.30–1.00 |
| Stock footage (Pexels/Pixabay) | free |
| Thumbnail (image model) | ~$0.04 |
| Render (own worker) | ~$0 |
| **Total** | **~$0.50–1.50** |

Fixed monthly: Vercel Pro $20, Railway worker ~$5, Supabase $0–25, ElevenLabs $5.
At three packages per week: **~$55–75/month all-in.**

Break-even needs roughly 10,000–15,000 long-form views/month. Realistically 3–6 months.

---

## 3. Architecture

Three runtimes, because rendering cannot live on Vercel — functions cap at 300s and
FFmpeg encoding is CPU-bound and longer than that.

```
┌─────────────────────────┐        ┌──────────────────────────┐
│  Next.js app (Vercel)   │        │  Render worker (Railway) │
│                         │        │                          │
│  UI, auth, services     │◀──────▶│  Node + FFmpeg           │
│  Gates 1 and 2          │  polls │  long video + 3 Shorts    │
│  Publishes to YouTube   │  jobs  │                          │
└───────────┬─────────────┘        └────────────┬─────────────┘
            │                                   │
            ▼                                   ▼
   ┌────────────────────┐            ┌────────────────────┐
   │ Supabase Postgres  │            │  Supabase Storage  │
   │ (Prisma)           │            │  audio, clips, mp4 │
   └────────────────────┘            └────────────────────┘
            │
            ▼
   ┌────────────────────────────────────────────────┐
   │ Vercel AI Gateway → Claude (script), image gen │
   │ ElevenLabs (voice) · Pexels/Pixabay (footage)  │
   │ YouTube Data API v3 (upload)                   │
   └────────────────────────────────────────────────┘
```

### Layering (unchanged from the existing codebase)

The strict one-directional layering in `README.md` is kept exactly as-is:
`app/ → features/ → services/ → lib/`. Providers are **only** called from service
classes. `config/env.ts` stays server-only and fails fast.

### Worker contract

The worker is deliberately dumb and stateless. It:

1. Polls `GET /api/jobs/claim` with a shared secret, receiving one `RenderJob`.
2. Downloads its inputs from Supabase Storage using signed URLs.
3. Runs FFmpeg, uploads outputs, streams progress to `POST /api/jobs/:id/progress`.
4. Reports terminal state to `POST /api/jobs/:id/complete`.

It holds no business logic and no provider keys. If the worker dies mid-job, the job's
lease expires and it is reclaimed.

`RenderJob` already has `attempts`, `startedAt`, and `progress`, but no lease expiry.
Sub-project 3 adds a `leaseExpiresAt` column and a `maxAttempts` guard — the only schema
change the whole pipeline requires.

### Orchestration: direct API calls, not agents

The pipeline calls provider APIs directly. It does not route orchestration through an
LLM agent or MCP. Orchestration must be deterministic, retryable, and auditable —
every step already writes to `VideoStatusEvent`, `ActivityLog`, and `RenderLog`.

An LLM is used only for judgment tasks: writing the script, titles, descriptions and
tags; matching stock clips to script sentences; selecting the three Shorts moments;
generating the thumbnail.

---

## 4. Pipeline and state machine

The existing `VideoStatus` enum already expresses the full flow. No schema change needed
for the state machine itself.

```
DRAFT       topic entered, script generated       ← 👤 GATE 1: approve script
QUEUED      operator approved, worker may claim
GENERATING  voice-over, footage, thumbnail          [automatic]
RENDERING   FFmpeg: long video + 3 Shorts           [automatic]
READY       renders complete                       ← 👤 GATE 2: watch, approve
PUBLISHED   uploaded to YouTube                     [automatic]
FAILED      terminal failure, reason recorded
```

**Gate 1** exists to spend money late: rejecting a bad script costs $0.05 instead of
$1.50. Once prompts are tuned, Gate 1 may be set to auto-approve per project.

**Gate 2 is permanent.** See the niche guardrails above.

Every transition appends a `VideoStatusEvent`. The `Video.status` column is a denormalised
UI hint; the event table is the durable record.

---

## 5. Sub-project decomposition

Four sub-projects, each independently useful, each with its own plan and implementation
cycle. This document specifies Sub-project 1 in detail.

| # | Name | Delivers |
|---|---|---|
| **1** | **Providers + Script** | Key vault, prompt library, projects, videos, topic → script, Gate 1 |
| 2 | Voice + Visuals | ElevenLabs narration, scene splitting, stock footage matching, thumbnails, storage |
| 3 | Render + Publish | Worker, job queue, FFmpeg assembly, Shorts extraction, YouTube OAuth + upload, Gate 2 |
| 4 | Analytics + Automation | YouTube stats sync, scheduling, one-click pipeline, cost dashboard |

---

## 6. Sub-project 1 — Providers + Script

### Outcome

The operator signs in, stores their API keys, edits the script prompt, creates a project
and a video from a topic, generates a script, reviews and edits it, and approves it —
moving the video to `QUEUED`. Cost of every generation is recorded.

### 6.1 Credential vault

`ProviderCredential` already models this: AES-256-GCM `encryptedKey`, `keyLastFour`,
`isActive`, `lastTestedAt`, `lastTestOk`, unique on `(userId, provider)`.

New module `lib/crypto.ts`:

```ts
encryptSecret(plaintext: string): string   // "<iv>.<authTag>.<ciphertext>", base64
decryptSecret(payload: string): string     // throws InternalError on tamper
```

Uses `CREDENTIAL_ENCRYPTION_KEY` (already validated as exactly 32 bytes in `config/env.ts`).
A random 12-byte IV per encryption. Decryption failure is never surfaced to the client.

`ProviderCredentialService` owns all access. `encryptedKey` is **never** selected into a
client-bound payload — services return `keyLastFour` only. This is enforced by an explicit
Prisma `select` in every read, and covered by a test.

**Key resolution order** for any provider call:

1. An active `ProviderCredential` for that provider, if present
2. The platform AI Gateway key from env (LLM and image only)
3. Otherwise throw `ProviderError(provider, "No credential configured", false)`

This keeps the operator on the AI Gateway by default while leaving the vault as the path
for ElevenLabs today and for bring-your-own-key SaaS users later.

**Test connection** performs the cheapest real call each provider offers (for the gateway,
a 1-token completion) and writes `lastTestedAt` / `lastTestOk`.

### 6.2 AI provider layer

New `services/providers/` with one narrow interface:

```ts
interface TextGenerationProvider {
  generateScript(input: ScriptGenerationInput): Promise<ScriptGenerationResult>;
}
```

`ScriptGenerationResult` carries `content`, `model`, `provider`, `inputTokens`,
`outputTokens`, `costUsd`, `latencyMs` — exactly the columns `ProviderUsage` needs.

Implemented with **AI SDK v6** against the **Vercel AI Gateway** using plain
`"anthropic/claude-..."` model strings. No provider-specific SDK package.

Every call — success or failure — writes one `ProviderUsage` row. Failures set
`succeeded: false` so the cost dashboard reflects wasted spend. Upstream errors are
wrapped in `ProviderError` with `retryable` set from the HTTP status (429 and 5xx are
retryable), which the existing error type already supports.

New env vars, added to `config/env.ts` and `.env.example`:

```
AI_GATEWAY_API_KEY=            # optional; required when no ANTHROPIC credential is stored
AI_SCRIPT_MODEL=anthropic/claude-sonnet-5
```

### 6.3 Prompt library

`PromptTemplate` + `PromptVariable` already model this, unique on `(userId, name)`,
categorised by `PromptCategory`.

Templates use `{{variable}}` placeholders. New `lib/prompt-template.ts`:

```ts
renderTemplate(content: string, values: Record<string, string>): string
extractVariables(content: string): string[]
```

Rendering throws `ValidationError` when a `required` variable has no value and no
`defaultValue`. Unknown placeholders are left untouched rather than silently emptied, so
a typo is visible in the output instead of producing a subtly wrong prompt.

The seed script ships one `isDefault` `SCRIPT` template encoding the niche guardrails
from section 2 — required sourcing, no advice, target word count, hook structure. Exactly
one template per category may be `isDefault` per user; the service enforces this in a
transaction.

### 6.4 Script generation

`ScriptService.generate(videoId, { templateId, variables })`:

1. Load the video, assert ownership, assert status is `DRAFT`.
2. Resolve the template (explicit, or the category default).
3. Render the prompt.
4. Call the provider.
5. In one transaction: upsert `Script`, insert `ScriptVersion` at `max(version) + 1`,
   point `activeVersionId` at it, write `ProviderUsage`, write `ActivityLog`.

`ScriptVersion` retains the rendered `prompt`, `model`, and `provider` — generations stay
reproducible. Versions are append-only; editing text creates a new version. The operator
can set any earlier version active.

`wordCount` is computed on write and drives the estimated duration shown at Gate 1
(~150 words per minute of narration).

### 6.5 Gate 1

`VideoService.approveScript(videoId)`:

- Asserts status `DRAFT` and a non-empty active `ScriptVersion`.
- Transitions to `QUEUED` and appends a `VideoStatusEvent`.
- Rejects with `ConflictError` if the video is in any other state.

Nothing consumes `QUEUED` until Sub-project 2. The gate is real from day one.

### 6.6 Surfaces

Five routes, built in this order:

| Route | Contents |
|---|---|
| `/providers` | Credential list, add/edit/revoke, test button, spend summary from `ProviderUsage` |
| `/prompts` | Template CRUD by category, variable editor, set-default |
| `/projects` | Project CRUD, archive, optional default channel |
| `/videos` | List with status filters, create-from-topic dialog |
| `/videos/[id]` | Script editor, version history, generate, regenerate, approve |

All are already declared in `config/navigation.ts` — no navigation changes needed.

### 6.7 Cleanup carried in this sub-project

- **Remove the `PREVIEW_MODE` scaffold** and the `*.preview.ts` services. The README
  marks them temporary; a real database exists from this point and the flag is a
  standing risk of serving a stubbed session.
- Replace `dashboard.preview.service.ts` fixtures with real queries.

### 6.8 Out of scope for Sub-project 1

Voice, footage, thumbnails, rendering, YouTube OAuth, publishing, analytics, scheduling.
`AiProviderType` values for video models (`GOOGLE_VEO`, `RUNWAY`, `KLING`, `PIKA`, `LUMA`)
stay in the enum but get no implementation — they are a later, optional upgrade for hero
shots once the channel earns.

---

## 7. Error handling

The existing `lib/errors.ts` hierarchy is sufficient and is used as-is.

- Services throw `AppError` subclasses; the action/route boundary calls
  `toSerializedError`, so driver messages never reach the browser.
- Provider failures become `ProviderError` with `retryable` derived from status code.
- Non-operational errors collapse to a generic `InternalError` client-side and are logged
  in full server-side via `ActivityLog` at `ERROR` level.
- Partial pipeline failure sets `Video.status = FAILED` with `failureReason`, and appends
  a `VideoStatusEvent`. Failed videos are retryable from their last good state rather than
  from the beginning, so a render failure never re-bills script and voice generation.

---

## 8. Testing

The project currently has no tests. Sub-project 1 introduces **Vitest**, proportionate to
risk rather than blanket coverage.

| Layer | What is tested |
|---|---|
| `lib/crypto.ts` | Round-trip, tamper detection, wrong-key rejection |
| `lib/prompt-template.ts` | Variable extraction, required-missing, unknown placeholder retained |
| Services | Ownership scoping, state-machine guards, version increment, usage row written |
| Security | `encryptedKey` never appears in any service return value |
| Cost | `ProviderUsage` written on both success and failure paths |

Service tests run against a real Postgres via `docker compose up -d postgres` and a
separate test database — the schema relies on constraints and transactions that a mock
would not exercise.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| YouTube demonetizes automated finance content | Permanent Gate 2, sourcing requirement, no-advice prompt guardrails, explanatory niche only |
| AI spend runs away | `ProviderUsage` on every call, spend surfaced on `/providers`, Gate 1 before expensive stages |
| Worker dies mid-render | Job leases with expiry and reclaim; retry from last good state |
| Stock footage repetition looks generic | Two sources (Pexels + Pixabay), clip reuse tracking in Sub-project 2 |
| Vercel Hobby terms forbid commercial use | Upgrade to Pro before the channel is monetized |
| ElevenLabs free tier lacks commercial rights | Paid Starter plan minimum before any published video |

---

## 10. Next step

Write the implementation plan for **Sub-project 1 — Providers + Script**.
