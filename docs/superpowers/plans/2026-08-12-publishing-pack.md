# Publishing Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a real, findable, on-brand video — AI title, description and
tags, an AI thumbnail carrying the channel's identity, and the visibility,
playlist and scheduling controls YouTube offers — with the operator's click
still the thing that publishes it.

**Architecture:** A per-channel `ChannelBrand` record becomes the one source of
identity every generator reads. Metadata and thumbnail generation are two new
pipeline stages that run automatically after a successful render and write to
the video; nothing publishes on its own. `publish()` stops hard-coding
`UNLISTED`, sends the stored tags and playlist, and uploads the thumbnail
through YouTube's separate `thumbnails.set` endpoint.

**Tech Stack:** TypeScript, Next.js 15, Prisma 7 (PostgreSQL/Supabase), Vitest,
AI SDK v7 (`ai@^7.0.58`) via Vercel AI Gateway — including `generateImage`,
which needs no new dependency — Zod v4, FFmpeg.

**Spec:** `docs/superpowers/specs/2026-08-12-publishing-pack-design.md`

## Global Constraints

- Every test creates its own throwaway user via `src/test/fixtures.ts`. **NEVER
  call `prisma.user.findFirstOrThrow()`** — a test once destroyed the
  operator's real ElevenLabs credential that way.
- Tests run against a REMOTE Supabase database and storage bucket shared with
  the operator's real data. Never delete or modify rows or objects you did not
  create.
- **Never publish to YouTube, generate a real image, or call a real provider
  from a test.** Every provider is injectable; inject a fake.
- The repository is PUBLIC. No secrets in code, tests, or commit messages.
- `pnpm typecheck` and `pnpm lint` must pass before every commit.
- **Nothing in this plan may turn a renderable video into a failed one, and
  nothing may fail a successful upload after the fact.** Every generated
  artefact is an enhancement.
- YouTube limits, enforced before upload: title ≤ 100 characters, description
  ≤ 5000, tags ≤ 500 characters combined.
- Thumbnails: 1280x720, JPEG, under 2 MB.
- A null `ChannelBrand.videoStyle` must merge to `DEFAULT_STYLE` exactly, so
  every existing channel renders as it does today. No backfill.

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` | `ChannelBrand` model; `Video.generatedTitle/generatedDescription/tags` |
| `src/services/brand.service.ts` (new) | Resolves a channel's brand, merging `videoStyle` over `DEFAULT_STYLE` |
| `src/services/metadata.service.ts` (new) | Title, description and tags from the script |
| `src/lib/youtube-limits.ts` (new) | Pure clamping/validation of YouTube's field limits |
| `src/services/providers/image.provider.ts` (new) | `ImageProvider` interface + AI Gateway implementation |
| `src/services/thumbnail.service.ts` (new) | Prompt, generate, composite, version |
| `src/lib/thumbnail-command.ts` (new) | Pure ffmpeg argument builders for the composite |
| `src/services/logo.service.ts` (new) | One-off logo options per channel |
| `src/services/publish.service.ts` | Visibility, tags, playlist, schedule, thumbnail upload |
| `src/services/pipeline-runner.ts` | Two new stages after `render` |

`youtube-limits.ts` and `thumbnail-command.ts` are deliberately pure and
dependency-free: field clamping and ffmpeg argument construction are the two
places this feature can be subtly wrong, and both are far easier to test in
isolation than through a pipeline.

---

### Task 1: ChannelBrand and the brand resolver

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `src/services/brand.service.ts`
- Test: `src/services/brand.service.test.ts`

**Interfaces:**
- Consumes: `VideoStyle`, `DEFAULT_STYLE` from `src/lib/video-style.ts`.
- Produces: `ResolvedBrand { videoStyle: VideoStyle; logoPath: string | null; primaryColour: string; secondaryColour: string; headlineFont: string; tone: string; niche: string; musicQuery: string }` and
  `brandService.resolve(channelId: string | null): Promise<ResolvedBrand>`.
  Every later task reads the brand through this, never from the table directly.

- [ ] **Step 1: Add the model**

In `prisma/schema.prisma`, after `ChannelStatistic`:

```prisma
/// A channel's identity: what its videos look like, sound like and are about.
///
/// Deliberately a separate table rather than columns on `Channel`. `Channel`
/// holds OAuth access and refresh tokens — the one row here whose accidental
/// exposure is a security incident, and whose own comment says those tokens are
/// never selected into client payloads. Brand fields are the opposite: read
/// constantly, rendered in the UI, edited by the operator. Separating them means
/// the brand editor never has to select from the row holding the tokens.
model ChannelBrand {
  id String @id @default(uuid()) @db.Uuid

  /// The VideoStyle object, merged over DEFAULT_STYLE. Null means "all
  /// defaults", so an existing channel renders exactly as it does today and
  /// this column needs no backfill.
  videoStyle Json?

  logoPath        String?
  primaryColour   String?
  secondaryColour String?
  /// Must exist in the worker image — libass and drawtext both fall back
  /// silently on a missing face.
  headlineFont    String?
  tone            String?
  niche           String?
  /// What to search Jamendo for. A channel's music should sound consistent,
  /// and a video's title is not a musical description — which is why searching
  /// by title found nothing usable.
  musicQuery      String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  channelId String  @unique @db.Uuid
  channel   Channel @relation(fields: [channelId], references: [id], onDelete: Cascade)

  @@map("channel_brand")
}
```

Add the back-relation to `Channel`: `brand ChannelBrand?`

- [ ] **Step 2: Migrate**

```bash
pnpm db:migrate --name add_channel_brand
pnpm db:generate
```

- [ ] **Step 3: Write the failing tests**

Create `src/services/brand.service.test.ts`:

```typescript
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { DEFAULT_STYLE } from "@/lib/video-style";
import { brandService } from "@/services/brand.service";
import { channelService } from "@/services/channel.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

let userId: string;
let channelId: string;

beforeEach(async () => {
  userId = await createTestUser("brand");
  const channel = await channelService.connect(userId, {
    youtubeChannelId: `UC_${randomUUID().slice(0, 8)}`,
    title: "Test channel",
    accessToken: "ya29.test",
    refreshToken: "1//test",
    expiresInSeconds: 3600,
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
  });
  channelId = channel.id;
});

afterEach(async () => {
  await deleteTestUser(userId);
});

describe("brandService.resolve", () => {
  it("returns every default when the channel has no brand row", async () => {
    const brand = await brandService.resolve(channelId);

    expect(brand.videoStyle).toEqual(DEFAULT_STYLE);
    expect(brand.logoPath).toBeNull();
  });

  it("returns defaults for a null channel", async () => {
    // A video whose project has no channel assigned still renders.
    const brand = await brandService.resolve(null);
    expect(brand.videoStyle).toEqual(DEFAULT_STYLE);
  });

  it("merges a partial videoStyle over the defaults rather than replacing it", async () => {
    await prisma.channelBrand.create({
      data: { channelId, videoStyle: { transitions: { durationSeconds: 0.25 } } },
    });

    const brand = await brandService.resolve(channelId);

    // The one named value wins; everything unnamed keeps its default, so a
    // brand that sets one field cannot silently blank the rest.
    expect(brand.videoStyle.transitions.durationSeconds).toBe(0.25);
    expect(brand.videoStyle.transitions.enabled).toBe(DEFAULT_STYLE.transitions.enabled);
    expect(brand.videoStyle.captions).toEqual(DEFAULT_STYLE.captions);
  });

  it("ignores a videoStyle that is not an object", async () => {
    // The column is Json; nothing stops a bad write. Rendering with garbage is
    // worse than rendering with defaults.
    await prisma.channelBrand.create({
      data: { channelId: channelId, videoStyle: "not an object" },
    });

    const brand = await brandService.resolve(channelId);
    expect(brand.videoStyle).toEqual(DEFAULT_STYLE);
  });

  it("returns the brand's own text fields when set", async () => {
    await prisma.channelBrand.create({
      data: {
        channelId,
        tone: "dry and factual",
        niche: "business history",
        musicQuery: "calm ambient documentary",
        primaryColour: "#FFCC00",
      },
    });

    const brand = await brandService.resolve(channelId);

    expect(brand.tone).toBe("dry and factual");
    expect(brand.niche).toBe("business history");
    expect(brand.musicQuery).toBe("calm ambient documentary");
    expect(brand.primaryColour).toBe("#FFCC00");
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run src/services/brand.service.test.ts`
Expected: FAIL — cannot resolve `@/services/brand.service`

- [ ] **Step 5: Implement**

Create `src/services/brand.service.ts`:

```typescript
import "server-only";

import { prisma } from "@/lib/prisma";
import type { VideoStyle } from "@/lib/video-style";
import { DEFAULT_STYLE } from "@/lib/video-style";

export interface ResolvedBrand {
  videoStyle: VideoStyle;
  logoPath: string | null;
  primaryColour: string;
  secondaryColour: string;
  headlineFont: string;
  tone: string;
  niche: string;
  musicQuery: string;
}

/** What a channel with no brand row gets. Chosen to be unremarkable rather
 *  than distinctive: a default that looks like a deliberate design would be
 *  worn by every channel that never set one. */
const FALLBACK = {
  primaryColour: "#FFFFFF",
  secondaryColour: "#000000",
  headlineFont: "DejaVu Sans",
  tone: "clear and factual",
  niche: "general interest",
  musicQuery: "calm ambient instrumental",
} as const;

/**
 * Merges a stored style over the defaults one section at a time.
 *
 * Not a deep merge and not a replacement. A brand that sets only
 * `transitions.durationSeconds` must keep every other transition field and
 * every other section — a replacement would silently blank them, and a fully
 * general deep merge would let a malformed column reach FFmpeg. Section by
 * section is exactly as much merging as `VideoStyle`'s shape needs.
 */
function mergeVideoStyle(stored: unknown): VideoStyle {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return DEFAULT_STYLE;
  }

  const partial = stored as Partial<Record<keyof VideoStyle, unknown>>;
  const merged = { ...DEFAULT_STYLE };

  for (const key of Object.keys(DEFAULT_STYLE) as (keyof VideoStyle)[]) {
    const section = partial[key];
    if (section && typeof section === "object" && !Array.isArray(section)) {
      merged[key] = { ...DEFAULT_STYLE[key], ...section } as never;
    }
  }

  return merged;
}

export class BrandService {
  /**
   * The one way anything reads a channel's identity.
   *
   * Never throws and never returns null: a missing brand row, a video whose
   * project has no channel, and a malformed `videoStyle` column all resolve to
   * defaults. Generation is an enhancement, and a channel that has not been
   * branded yet must still render and publish.
   */
  async resolve(channelId: string | null): Promise<ResolvedBrand> {
    const brand = channelId
      ? await prisma.channelBrand.findUnique({ where: { channelId } })
      : null;

    return {
      videoStyle: mergeVideoStyle(brand?.videoStyle),
      logoPath: brand?.logoPath ?? null,
      primaryColour: brand?.primaryColour ?? FALLBACK.primaryColour,
      secondaryColour: brand?.secondaryColour ?? FALLBACK.secondaryColour,
      headlineFont: brand?.headlineFont ?? FALLBACK.headlineFont,
      tone: brand?.tone ?? FALLBACK.tone,
      niche: brand?.niche ?? FALLBACK.niche,
      musicQuery: brand?.musicQuery ?? FALLBACK.musicQuery,
    };
  }
}

export const brandService = new BrandService();
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/services/brand.service.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 7: Typecheck, lint and commit**

```bash
pnpm typecheck && pnpm lint
git add prisma src/services/brand.service.ts src/services/brand.service.test.ts
git commit -m "feat: give a channel an identity its videos can read"
```

---

### Task 2: YouTube field limits

**Files:**
- Create: `src/lib/youtube-limits.ts`
- Test: `src/lib/youtube-limits.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `TITLE_MAX = 100`, `DESCRIPTION_MAX = 5000`, `TAGS_MAX = 500`,
  `clampTitle(value: string): string`, `clampDescription(value: string): string`,
  `clampTags(tags: string[]): string[]`, and
  `withinLimits(input: { title: string; description: string; tags: string[] }): boolean`.
  Task 3 uses these; Task 5 does not.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/youtube-limits.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import {
  clampDescription,
  clampTags,
  clampTitle,
  DESCRIPTION_MAX,
  TAGS_MAX,
  TITLE_MAX,
  withinLimits,
} from "@/lib/youtube-limits";

describe("clampTitle", () => {
  it("leaves a title that already fits", () => {
    expect(clampTitle("How inflation actually works")).toBe(
      "How inflation actually works",
    );
  });

  it("truncates on a word boundary rather than mid-word", () => {
    const title = clampTitle(`${"word ".repeat(40)}end`);

    expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
    // Cutting mid-word reads as a bug to a viewer; cutting at a space reads as
    // a short title.
    expect(title.endsWith(" ")).toBe(false);
    expect(title).not.toMatch(/wor$/);
  });

  it("falls back to a hard cut when there is no space to cut at", () => {
    const title = clampTitle("x".repeat(200));
    expect(title).toHaveLength(TITLE_MAX);
  });
});

describe("clampTags", () => {
  it("keeps tags whose combined length fits", () => {
    expect(clampTags(["money", "inflation", "economics"])).toEqual([
      "money",
      "inflation",
      "economics",
    ]);
  });

  it("drops whole tags from the end rather than truncating one", () => {
    // A truncated tag is a different, meaningless tag. Dropping is the only
    // lossless option.
    const tags = clampTags(Array.from({ length: 60 }, (_tag, i) => `tag-number-${i}`));

    const combined = tags.join("").length;
    expect(combined).toBeLessThanOrEqual(TAGS_MAX);
    for (const tag of tags) {
      expect(tag).toMatch(/^tag-number-\d+$/);
    }
  });

  it("drops empty and whitespace-only tags", () => {
    expect(clampTags(["money", "", "   ", "debt"])).toEqual(["money", "debt"]);
  });
});

describe("withinLimits", () => {
  it("accepts a compliant set", () => {
    expect(
      withinLimits({ title: "Short", description: "Body", tags: ["a", "b"] }),
    ).toBe(true);
  });

  it("rejects an over-long description", () => {
    expect(
      withinLimits({
        title: "Short",
        description: "x".repeat(DESCRIPTION_MAX + 1),
        tags: [],
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/youtube-limits.test.ts`
Expected: FAIL — cannot resolve `@/lib/youtube-limits`

- [ ] **Step 3: Implement**

Create `src/lib/youtube-limits.ts`:

```typescript
/**
 * YouTube's own field limits, enforced before the upload rather than
 * discovered during it.
 *
 * A rejection arrives as a 400 after the video bytes have already been sent —
 * the most expensive possible moment to learn the title was too long, since
 * the upload is the single most quota-costly call this app makes (1,600 units
 * against a daily allowance).
 */
export const TITLE_MAX = 100;
export const DESCRIPTION_MAX = 5000;
/** Combined length of every tag, not the count. */
export const TAGS_MAX = 500;

/** Cuts at the last space inside the limit, so a clipped title reads as short
 *  rather than as broken. Falls back to a hard cut when the text has no space
 *  to cut at — a single 200-character word is not a case worth preserving. */
function truncateOnWord(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }

  const hardCut = value.slice(0, max);
  const lastSpace = hardCut.lastIndexOf(" ");

  return lastSpace > 0 ? hardCut.slice(0, lastSpace) : hardCut;
}

export function clampTitle(value: string): string {
  return truncateOnWord(value.trim(), TITLE_MAX);
}

export function clampDescription(value: string): string {
  return truncateOnWord(value.trim(), DESCRIPTION_MAX);
}

/**
 * Drops whole tags from the end until the combined length fits.
 *
 * Never truncates a tag: half of "cryptocurrency" is a different word that
 * nobody searches for, so a shortened tag is worse than an absent one.
 */
export function clampTags(tags: string[]): string[] {
  const kept: string[] = [];
  let combined = 0;

  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag) {
      continue;
    }
    if (combined + tag.length > TAGS_MAX) {
      break;
    }
    kept.push(tag);
    combined += tag.length;
  }

  return kept;
}

export function withinLimits(input: {
  title: string;
  description: string;
  tags: string[];
}): boolean {
  return (
    input.title.length <= TITLE_MAX &&
    input.description.length <= DESCRIPTION_MAX &&
    input.tags.join("").length <= TAGS_MAX
  );
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/lib/youtube-limits.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: Typecheck, lint and commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/youtube-limits.ts src/lib/youtube-limits.test.ts
git commit -m "feat: clamp metadata to YouTube's limits before the upload, not during it"
```

---

### Task 3: Metadata generation

**Files:**
- Modify: `prisma/schema.prisma` (`Video`)
- Modify: `src/services/providers/types.ts`
- Modify: `src/services/providers/gateway.provider.ts`
- Create: `src/services/metadata.service.ts`
- Test: `src/services/metadata.service.test.ts`

**Interfaces:**
- Consumes: `brandService.resolve` (Task 1); `clampTitle`, `clampDescription`,
  `clampTags`, `withinLimits` (Task 2).
- Produces: `VideoMetadata { title: string; description: string; tags: string[] }`,
  `TextGenerationProvider.generateMetadata(input: MetadataGenerationInput): Promise<VideoMetadata>`,
  and `metadataService.generate(userId: string, videoId: string): Promise<VideoMetadata | null>`
  which writes `Video.generatedTitle`, `Video.generatedDescription` and
  `Video.tags`. Returns `null` when generation failed — never throws.

- [ ] **Step 1: Add the columns**

In `prisma/schema.prisma`, on `Video`, after `description`:

```prisma
  /// Written by MetadataService, kept separate from the operator's own `title`
  /// and `description` so a model can never silently overwrite what a human
  /// typed. `publish()` sends `generatedTitle ?? title`.
  generatedTitle       String?
  generatedDescription String?
  tags                 String[]
```

```bash
pnpm db:migrate --name add_video_generated_metadata
pnpm db:generate
```

- [ ] **Step 2: Write the failing tests**

Create `src/services/metadata.service.test.ts`:

```typescript
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { TITLE_MAX } from "@/lib/youtube-limits";
import { MetadataService } from "@/services/metadata.service";
import { projectService } from "@/services/project.service";
import { videoService } from "@/services/video.service";
import { createTestUser, deleteTestUser } from "@/test/fixtures";

vi.setConfig({ testTimeout: 20_000 });

const RUN = randomUUID().slice(0, 8);

let userId: string;
let videoId: string;

async function makeVideoWithScript(content = "Money is weirder than you think.") {
  const project = await projectService.create(userId, { name: `meta-${RUN}` });
  const video = await videoService.create(userId, {
    projectId: project.id,
    title: "Operator's own title",
    topic: "money",
  });

  const script = await prisma.script.create({ data: { videoId: video.id } });
  const version = await prisma.scriptVersion.create({
    data: { scriptId: script.id, version: 1, content },
  });
  await prisma.script.update({
    where: { id: script.id },
    data: { activeVersionId: version.id },
  });

  return video.id;
}

beforeEach(async () => {
  userId = await createTestUser("metadata");
  videoId = await makeVideoWithScript();
});

afterEach(async () => {
  await deleteTestUser(userId);
});

describe("MetadataService.generate", () => {
  it("stores the generated fields without touching the operator's title", async () => {
    const service = new MetadataService({
      generateMetadata: async () => ({
        title: "How inflation actually works",
        description: "The full explanation.",
        tags: ["money", "inflation"],
      }),
    });

    await service.generate(userId, videoId);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.generatedTitle).toBe("How inflation actually works");
    expect(video.tags).toEqual(["money", "inflation"]);
    // The human's title survives, by construction rather than by convention.
    expect(video.title).toBe("Operator's own title");
  });

  it("clamps an over-long title rather than letting YouTube reject it", async () => {
    const service = new MetadataService({
      generateMetadata: async () => ({
        title: `${"word ".repeat(40)}end`,
        description: "Body",
        tags: [],
      }),
    });

    await service.generate(userId, videoId);

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.generatedTitle!.length).toBeLessThanOrEqual(TITLE_MAX);
  });

  it("retries once with the limits restated before clamping", async () => {
    const generateMetadata = vi
      .fn()
      .mockResolvedValueOnce({
        title: "x".repeat(300),
        description: "Body",
        tags: [],
      })
      .mockResolvedValueOnce({
        title: "A title that fits",
        description: "Body",
        tags: [],
      });

    await new MetadataService({ generateMetadata }).generate(userId, videoId);

    expect(generateMetadata).toHaveBeenCalledTimes(2);
    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.generatedTitle).toBe("A title that fits");
  });

  it("returns null and leaves the video publishable when generation fails", async () => {
    const service = new MetadataService({
      generateMetadata: async () => {
        throw new Error("gateway down");
      },
    });

    // Metadata is an enhancement: a video with none still publishes under the
    // operator's own title.
    expect(await service.generate(userId, videoId)).toBeNull();

    const video = await prisma.video.findUniqueOrThrow({ where: { id: videoId } });
    expect(video.generatedTitle).toBeNull();
    expect(video.title).toBe("Operator's own title");
  });

  it("refuses a video with no approved script", async () => {
    const project = await projectService.create(userId, { name: `meta-bare-${RUN}` });
    const bare = await videoService.create(userId, {
      projectId: project.id,
      title: "No script",
    });

    const service = new MetadataService({
      generateMetadata: async () => ({ title: "t", description: "d", tags: [] }),
    });

    expect(await service.generate(userId, bare.id)).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/services/metadata.service.test.ts`
Expected: FAIL — cannot resolve `@/services/metadata.service`

- [ ] **Step 4: Extend the provider contract**

In `src/services/providers/types.ts`:

```typescript
export interface MetadataGenerationInput {
  /** The narration the metadata must describe. */
  script: string;
  tone: string;
  niche: string;
  /** Restated limits on a retry, so the model is told what it broke. */
  limitsReminder?: string;
  apiKey?: string;
}

export interface VideoMetadata {
  title: string;
  description: string;
  tags: string[];
}
```

Add to `TextGenerationProvider`:

```typescript
  generateMetadata(input: MetadataGenerationInput): Promise<VideoMetadata>;
```

- [ ] **Step 5: Implement it on the gateway provider**

In `src/services/providers/gateway.provider.ts`, add alongside `scriptSchema`:

```typescript
const metadataSchema = z.object({
  title: z
    .string()
    .describe(
      "A YouTube title under 100 characters. State the payoff; no clickbait " +
        "the video does not deliver.",
    ),
  description: z
    .string()
    .describe(
      "A YouTube description under 5000 characters: two or three sentences on " +
        "what the video covers, then nothing else. Sources and credits are " +
        "appended separately and must not appear here.",
    ),
  tags: z
    .array(z.string())
    .describe(
      "Search terms a viewer would actually type. Combined length under 500 " +
        "characters.",
    ),
});
```

and a `generateMetadata` method on `GatewayProvider` that calls `generateObject`
with that schema, prompting with the script, tone, niche and — when
`limitsReminder` is present — that reminder.

- [ ] **Step 6: Implement the service**

Create `src/services/metadata.service.ts`:

```typescript
import "server-only";

import { prisma } from "@/lib/prisma";
import {
  clampDescription,
  clampTags,
  clampTitle,
  DESCRIPTION_MAX,
  TAGS_MAX,
  TITLE_MAX,
  withinLimits,
} from "@/lib/youtube-limits";
import { brandService } from "@/services/brand.service";
import { gatewayProvider } from "@/services/providers/gateway.provider";
import type { TextGenerationProvider, VideoMetadata } from "@/services/providers/types";

const LIMITS_REMINDER =
  `The previous attempt broke a limit. Title must be at most ${TITLE_MAX} ` +
  `characters, description at most ${DESCRIPTION_MAX}, and all tags together ` +
  `at most ${TAGS_MAX} characters.`;

export class MetadataService {
  constructor(
    private readonly provider: Pick<TextGenerationProvider, "generateMetadata"> =
      gatewayProvider,
  ) {}

  /**
   * Writes the video's generated title, description and tags.
   *
   * Returns `null` rather than throwing on any failure. Metadata is an
   * enhancement to a video that is already renderable and publishable: with
   * none, `publish()` falls back to the operator's own title and today's
   * description. Nothing here may block a video.
   */
  async generate(userId: string, videoId: string): Promise<VideoMetadata | null> {
    try {
      const video = await prisma.video.findFirst({
        where: { id: videoId, userId, deletedAt: null },
        select: {
          script: { select: { activeVersion: { select: { content: true } } } },
          project: { select: { channelId: true } },
        },
      });

      const script = video?.script?.activeVersion?.content;
      if (!script) {
        return null;
      }

      const brand = await brandService.resolve(video.project?.channelId ?? null);

      // One retry with the limits restated, because a model that overran once
      // usually complies when told exactly what it broke — and a retry is far
      // cheaper than a clamped title that reads as truncated.
      let generated = await this.provider.generateMetadata({
        script,
        tone: brand.tone,
        niche: brand.niche,
      });

      if (!withinLimits(generated)) {
        generated = await this.provider.generateMetadata({
          script,
          tone: brand.tone,
          niche: brand.niche,
          limitsReminder: LIMITS_REMINDER,
        });
      }

      const metadata: VideoMetadata = {
        title: clampTitle(generated.title),
        description: clampDescription(generated.description),
        tags: clampTags(generated.tags),
      };

      await prisma.video.update({
        where: { id: videoId },
        data: {
          generatedTitle: metadata.title,
          generatedDescription: metadata.description,
          tags: metadata.tags,
        },
      });

      return metadata;
    } catch (error) {
      console.error(
        `Could not generate metadata for video ${videoId}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return null;
    }
  }
}

export const metadataService = new MetadataService();
```

- [ ] **Step 7: Run to verify they pass**

Run: `npx vitest run src/services/metadata.service.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 8: Typecheck, lint and commit**

```bash
pnpm typecheck && pnpm lint
git add prisma src/services/metadata.service.ts src/services/metadata.service.test.ts src/services/providers
git commit -m "feat: write a title, description and tags a viewer could find"
```

---

### Task 4: Publish controls

**Files:**
- Modify: `src/services/publish.service.ts`
- Test: `src/services/publish.service.test.ts`

**Interfaces:**
- Consumes: `Video.generatedTitle`, `generatedDescription`, `tags` (Task 3).
- Produces: `publish(userId: string, videoId: string, opts?: { visibility?: PublishVisibility; playlistId?: string; scheduledFor?: Date }): Promise<PublishResult>`.
  Task 6 adds the thumbnail upload to the same method.

- [ ] **Step 1: Write the failing tests**

Add to `src/services/publish.service.test.ts`:

```typescript
describe("publishService.publish — metadata and visibility", () => {
  it("sends the generated title and tags, not the operator's placeholder", async () => {
    const { videoId } = await makePublishableVideo();
    await prisma.video.update({
      where: { id: videoId },
      data: {
        generatedTitle: "How inflation actually works",
        generatedDescription: "The full explanation.",
        tags: ["money", "inflation"],
      },
    });

    const { fetchImpl, calls } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId);

    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.snippet.title).toBe("How inflation actually works");
    expect(body.snippet.tags).toEqual(["money", "inflation"]);
  });

  it("falls back to the operator's title when nothing was generated", async () => {
    const { videoId } = await makePublishableVideo();

    const { fetchImpl, calls } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId);

    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.snippet.title).toBe("How inflation actually works");
  });

  it("publishes at the visibility asked for, not a constant", async () => {
    const { videoId } = await makePublishableVideo();

    const { fetchImpl, calls } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId, { visibility: "PUBLIC" });

    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.status.privacyStatus).toBe("public");

    const publication = await prisma.publication.findUniqueOrThrow({ where: { videoId } });
    expect(publication.visibility).toBe("PUBLIC");
  });

  it("defaults to private rather than to whatever it used to hard-code", async () => {
    const { videoId } = await makePublishableVideo();

    const { fetchImpl, calls } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId);

    const body = JSON.parse(calls[0].init!.body as string);
    expect(body.status.privacyStatus).toBe("private");
  });

  it("schedules with publishAt and a private status, which is how YouTube schedules", async () => {
    const { videoId } = await makePublishableVideo();
    const scheduledFor = new Date("2030-01-01T12:00:00.000Z");

    const { fetchImpl, calls } = createUploadFetch();
    await new PublishService(fetchImpl).publish(userId, videoId, {
      visibility: "PUBLIC",
      scheduledFor,
    });

    const body = JSON.parse(calls[0].init!.body as string);
    // A scheduled upload must go up private; publishAt is what flips it later.
    expect(body.status.privacyStatus).toBe("private");
    expect(body.status.publishAt).toBe(scheduledFor.toISOString());
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/services/publish.service.test.ts -t "metadata and visibility"`
Expected: FAIL — `publish` takes two arguments; title comes from `video.title`

- [ ] **Step 3: Implement**

In `src/services/publish.service.ts`:

- Add `generatedTitle`, `generatedDescription` and `tags` to the video `select`.
- Add the options parameter, defaulting `visibility` to `"PRIVATE"`.
- Replace the `privacyStatus: "unlisted"` hard-code. Delete its comment — its
  stated reason (free-tier ElevenLabs audio carrying no commercial rights) no
  longer holds, and leaving a comment that argues for a constant the code no
  longer uses is worse than no comment. Replace it with one that says
  visibility is the caller's decision and defaults to private.
- Send `tags`, and `publishAt` with `privacyStatus: "private"` when
  `scheduledFor` is set.
- Use `generatedTitle ?? title`, and append the sources/credits block to
  `generatedDescription` when it exists.
- Persist `visibility`, `tags`, `playlistId` and `scheduledFor` on the
  `Publication`.

- [ ] **Step 4: Run the full file**

Run: `npx vitest run src/services/publish.service.test.ts`
Expected: PASS — all existing tests plus 5 new

- [ ] **Step 5: Typecheck, lint and commit**

```bash
pnpm typecheck && pnpm lint
git add src/services/publish.service.ts src/services/publish.service.test.ts
git commit -m "feat: let the operator choose who can see a published video"
```

---

### Task 5: The image provider

**Files:**
- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Modify: `src/services/providers/types.ts`
- Create: `src/services/providers/image.provider.ts`
- Test: `src/services/providers/image.provider.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `GeneratedImage { data: Buffer; model: string }`,
  `ImageProvider { generate(input: { prompt: string; aspectRatio: "16:9" | "1:1" }): Promise<GeneratedImage> }`,
  and the singleton `gatewayImageProvider`. Tasks 6 and 8 consume it.

- [ ] **Step 1: Add the env key**

In `src/config/env.ts`, beside `AI_SCRIPT_MODEL`:

```typescript
  /** Image model for thumbnails and logos, through the same gateway as
   *  AI_SCRIPT_MODEL. */
  AI_IMAGE_MODEL: z.string().min(1).default("openai/gpt-image-1"),
```

Add `AI_IMAGE_MODEL=` to `.env.example` under the AI grouping.

- [ ] **Step 2: Write the failing tests**

Create `src/services/providers/image.provider.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";

import { GatewayImageProvider } from "@/services/providers/image.provider";

describe("GatewayImageProvider", () => {
  it("returns the generated bytes and the model that made them", async () => {
    const generate = vi.fn().mockResolvedValue({
      image: { uint8Array: new Uint8Array([1, 2, 3]) },
    });

    const result = await new GatewayImageProvider(generate).generate({
      prompt: "a city at night",
      aspectRatio: "16:9",
    });

    expect(result.data).toEqual(Buffer.from([1, 2, 3]));
    expect(result.model).toBeTruthy();
  });

  it("passes the aspect ratio through", async () => {
    const generate = vi.fn().mockResolvedValue({
      image: { uint8Array: new Uint8Array([1]) },
    });

    await new GatewayImageProvider(generate).generate({
      prompt: "a logo",
      aspectRatio: "1:1",
    });

    expect(generate.mock.calls[0][0].aspectRatio).toBe("1:1");
  });

  it("raises a retryable ProviderError when the gateway is unreachable", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

    await expect(
      new GatewayImageProvider(generate).generate({
        prompt: "x",
        aspectRatio: "16:9",
      }),
    ).rejects.toMatchObject({ retryable: true });
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/services/providers/image.provider.test.ts`
Expected: FAIL — cannot resolve `@/services/providers/image.provider`

- [ ] **Step 4: Implement**

Create `src/services/providers/image.provider.ts` with a `GatewayImageProvider`
class whose constructor takes the AI SDK's `generateImage` (defaulted to the
real one, injected in tests), reads `env.AI_IMAGE_MODEL`, wraps any thrown
error in `ProviderError("GATEWAY", …, true)`, and returns
`{ data: Buffer.from(result.image.uint8Array), model: env.AI_IMAGE_MODEL }`.
Export `gatewayImageProvider`.

Add `GeneratedImage` and `ImageProvider` to `src/services/providers/types.ts`.

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run src/services/providers/image.provider.test.ts`
Expected: PASS — 3 tests

- [ ] **Step 6: Typecheck, lint and commit**

```bash
pnpm typecheck && pnpm lint
git add src/config/env.ts .env.example src/services/providers/image.provider.ts src/services/providers/image.provider.test.ts src/services/providers/types.ts
git commit -m "feat: generate images through the gateway that already writes the scripts"
```

---

### Task 6: The thumbnail composite

**Files:**
- Create: `src/lib/thumbnail-command.ts`
- Test: `src/lib/thumbnail-command.test.ts`

**Interfaces:**
- Consumes: `ResolvedBrand` (Task 1).
- Produces: `THUMBNAIL_WIDTH = 1280`, `THUMBNAIL_HEIGHT = 720`,
  `buildThumbnailArgs(input: { imagePath: string; outputPath: string; headline: string; brand: Pick<ResolvedBrand, "primaryColour" | "headlineFont">; logoPath?: string | null }): string[]`.
  Task 7 runs these.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/thumbnail-command.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import {
  buildThumbnailArgs,
  THUMBNAIL_HEIGHT,
  THUMBNAIL_WIDTH,
} from "@/lib/thumbnail-command";

const brand = { primaryColour: "#FFCC00", headlineFont: "DejaVu Sans" };
const base = {
  imagePath: "/tmp/image.png",
  outputPath: "/tmp/thumb.jpg",
  headline: "Money is weirder than you think",
  brand,
};

function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe("buildThumbnailArgs", () => {
  it("outputs at YouTube's thumbnail size", () => {
    const filter = args();
    expect(filter).toContain(`scale=${THUMBNAIL_WIDTH}:${THUMBNAIL_HEIGHT}`);
    expect(filter).toContain(`crop=${THUMBNAIL_WIDTH}:${THUMBNAIL_HEIGHT}`);
  });

  it("draws the headline rather than asking the model to render it", () => {
    // Image models misspell, invent glyphs and break kerning. Every AI
    // thumbnail that looks professional has its text composited.
    expect(args()).toContain("drawtext=");
    expect(args()).toContain("Money is weirder");
  });

  it("escapes a headline containing filter-graph syntax", () => {
    const built = buildThumbnailArgs({
      ...base,
      headline: "Inflation: what it costs, really",
    });

    // A bare colon ends the drawtext option and a bare apostrophe ends the
    // quoted value — either turns a headline into a broken FFmpeg command.
    const graph = valueOf(built, "-vf") ?? "";
    expect(graph).toContain("\\:");
  });

  it("overlays the logo only when there is one", () => {
    expect(buildThumbnailArgs({ ...base, logoPath: "/tmp/logo.png" }).join(" ")).toContain(
      "overlay",
    );
    expect(buildThumbnailArgs(base).join(" ")).not.toContain("overlay");
  });

  it("writes a JPEG at a quality that stays under YouTube's 2MB cap", () => {
    const built = buildThumbnailArgs(base);
    expect(valueOf(built, "-q:v")).toBeDefined();
    expect(built.at(-1)).toBe("/tmp/thumb.jpg");
  });
});

function args(): string {
  return buildThumbnailArgs(base).join(" ");
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/thumbnail-command.test.ts`
Expected: FAIL — cannot resolve `@/lib/thumbnail-command`

- [ ] **Step 3: Implement**

Create `src/lib/thumbnail-command.ts`. It must:

- Scale and crop the generated image to exactly 1280x720 (`force_original_aspect_ratio=increase` then `crop`, the same shape `buildSegmentArgs` uses).
- Draw the headline with `drawtext`, using the brand's font and colour, with a
  contrasting box or border so text stays readable over any image.
- Escape the headline for the filter-graph parser — `:`, `'`, `\` and `%` all
  have meaning inside `drawtext`, and a colon in a real headline is common.
- `overlay` the logo in a corner when `logoPath` is given, and omit the input
  and the filter entirely when it is not.
- Encode JPEG with `-q:v` chosen to land well under 2 MB at this size.

Give the escaping function a doc comment naming the characters and why.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/lib/thumbnail-command.test.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: Typecheck, lint and commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/thumbnail-command.ts src/lib/thumbnail-command.test.ts
git commit -m "feat: composite the thumbnail's text instead of generating it"
```

---

### Task 7: The thumbnail service

**Files:**
- Create: `src/services/thumbnail.service.ts`
- Test: `src/services/thumbnail.service.test.ts`

**Interfaces:**
- Consumes: `brandService.resolve` (1), `ImageProvider` (5),
  `buildThumbnailArgs` (6), `ProcessSpawner` from `render.service.ts`.
- Produces: `thumbnailService.generate(userId: string, videoId: string): Promise<string | null>`
  returning the storage path of the active thumbnail, or `null`. Never throws.
  Task 8 uploads it; Task 9 runs it as a pipeline stage.

- [ ] **Step 1: Write the failing tests**

Create `src/services/thumbnail.service.test.ts` covering:

```typescript
describe("ThumbnailService.generate", () => {
  it("stores a version whose prompt can reproduce it", async () => {
    // ThumbnailVersion.prompt exists precisely so a good thumbnail is
    // repeatable; a version without it is a dead end.
  });

  it("appends a version and moves the active pointer rather than overwriting", async () => {
    // Regenerating is the expected workflow — the first image is often wrong.
  });

  it("returns null when image generation fails, leaving the video publishable", async () => {});

  it("falls back to the raw image when compositing fails", async () => {
    // A thumbnail without a headline still beats YouTube picking a frame.
  });

  it("never calls a real image provider or spawns a real ffmpeg", async () => {});
});
```

Write these out fully against the injected `ImageProvider` and the injected
`ProcessSpawner`, following `render.service.test.ts`'s `createSpawner` helper
for the latter.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/services/thumbnail.service.test.ts`
Expected: FAIL — cannot resolve `@/services/thumbnail.service`

- [ ] **Step 3: Implement**

Create `src/services/thumbnail.service.ts`. `generate` must:

1. Load the video's active script and its project's channel; return `null` if
   there is no script.
2. Resolve the brand.
3. Build the prompt from the script's opening — the hook is what the thumbnail
   illustrates — plus the brand's tone and niche.
4. Generate the image; on failure log and return `null`.
5. Write the raw image to a temp dir, run `buildThumbnailArgs` through the
   injected spawner, and on failure use the raw image rather than nothing.
6. `putObject` the result at `storagePath(videoId, "thumbnails", "thumbnail-NNN.jpg")`
   and append a `ThumbnailVersion` with `prompt`, `provider`, `model` and
   `imageUrl`, moving `Thumbnail.activeVersionId` to it.
7. Return the storage path.

Add `"thumbnails"` to `StorageKind` in `src/lib/storage.ts`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/services/thumbnail.service.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck, lint and commit**

```bash
pnpm typecheck && pnpm lint
git add src/services/thumbnail.service.ts src/services/thumbnail.service.test.ts src/lib/storage.ts
git commit -m "feat: give each video a thumbnail somebody might click"
```

---

### Task 8: Upload the thumbnail to YouTube

**Files:**
- Modify: `src/services/publish.service.ts`
- Test: `src/services/publish.service.test.ts`

**Interfaces:**
- Consumes: the active `ThumbnailVersion` written by Task 7.
- Produces: no new exports; `publish()` uploads the thumbnail after the video
  insert and records whether it was applied.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("publishService.publish — thumbnail", () => {
  it("uploads the thumbnail after the video insert, not with it", async () => {
    // thumbnails.set is a separate endpoint; it cannot ride along with
    // videos.insert.
  });

  it("leaves the video published when the channel is unverified (403)", async () => {
    // Custom thumbnails require a verified YouTube channel. That is a property
    // of the operator's account, not something this code can satisfy — and
    // failing an otherwise-successful upload over a thumbnail is the wrong
    // trade.
  });

  it("skips the thumbnail call entirely when the video has none", async () => {
    // 50 quota units, against the same daily allowance as the 1,600 the upload
    // itself costs.
  });
});
```

Write these fully, extending `createUploadFetch` to recognise the
`thumbnails/set` URL and to be able to fail it with a 403.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/services/publish.service.test.ts -t "thumbnail"`
Expected: FAIL — no request is made to `thumbnails/set`

- [ ] **Step 3: Implement**

After the successful video insert and inside the same `try`, load the active
`ThumbnailVersion`, download its object, and `POST` it to
`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId={id}`.
Wrap the whole thumbnail attempt so **no** failure — 403 or otherwise — can
reach the publish's failure branch: the video is already on YouTube and must
not be marked FAILED. Record the outcome on the `Publication`.

- [ ] **Step 4: Run the full file**

Run: `npx vitest run src/services/publish.service.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck, lint and commit**

```bash
pnpm typecheck && pnpm lint
git add src/services/publish.service.ts src/services/publish.service.test.ts
git commit -m "feat: put the thumbnail on the video after it lands"
```

---

### Task 9: Logo generation and the pipeline stages

**Files:**
- Create: `src/services/logo.service.ts`
- Test: `src/services/logo.service.test.ts`
- Modify: `src/services/pipeline-runner.ts`
- Modify: `src/services/pipeline.service.ts`
- Test: `src/services/pipeline.service.test.ts`

**Interfaces:**
- Consumes: `ImageProvider` (5), `brandService` (1), `metadataService` (3),
  `thumbnailService` (7).
- Produces: `logoService.generateOptions(userId: string, channelId: string, count?: number): Promise<string[]>`
  returning storage paths, and `logoService.choose(userId: string, channelId: string, logoPath: string): Promise<void>`
  which writes `ChannelBrand.logoPath`. Two new `PipelineStageName` values:
  `"metadata"` and `"thumbnail"`.

- [ ] **Step 1: Write the failing logo tests**

```typescript
describe("LogoService", () => {
  it("generates the requested number of options and stores each", async () => {});

  it("stores the chosen logo on the channel's brand, creating the row if needed", async () => {
    // A channel may have no brand row yet; choosing a logo is often the first
    // branding action an operator takes.
  });

  it("returns an empty list rather than throwing when generation fails", async () => {});
});
```

- [ ] **Step 2: Run to verify they fail, then implement `logo.service.ts`**

`generateOptions` builds a square prompt from the channel's title, tone and
niche, calls the image provider `count` times (default 3), stores each at
`storagePath(channelId, "logos", "logo-N.png")` and returns the paths.
`choose` upserts `ChannelBrand` with the path.

Note: `storagePath`'s first argument is named `videoId` but is only ever a
prefix segment; passing a channel id is a widening of meaning, so rename the
parameter to `ownerId` in `src/lib/storage.ts` and update its doc comment
rather than passing a channel id to something called `videoId`.

- [ ] **Step 3: Write the failing pipeline tests**

```typescript
describe("pipeline stages", () => {
  it("reports metadata and thumbnail as stages after render", async () => {});

  it("shows metadata done once the video has a generated title", async () => {});

  it("shows thumbnail done once a thumbnail version exists", async () => {});
});
```

- [ ] **Step 4: Implement the stages**

In `src/services/pipeline-runner.ts`, add `metadata` and `thumbnail` to
`PipelineStageName` and run them after `render`, each wrapped so a failure is
reported as a failed stage but does not fail the pipeline — the video is
already rendered and `READY` is still the right outcome.

In `src/services/pipeline.service.ts`, add both to `STAGE_ORDER` and
`STAGE_LABELS`, and derive their status: metadata is done when
`generatedTitle` is set, thumbnail when the video has a `Thumbnail` with an
`activeVersionId`.

- [ ] **Step 5: Run both suites**

Run: `npx vitest run src/services/logo.service.test.ts src/services/pipeline.service.test.ts`
Expected: PASS

- [ ] **Step 6: Typecheck, lint and commit**

```bash
pnpm typecheck && pnpm lint
git add src/services/logo.service.ts src/services/logo.service.test.ts src/services/pipeline-runner.ts src/services/pipeline.service.ts src/services/pipeline.service.test.ts src/lib/storage.ts
git commit -m "feat: brand the channel and run generation as pipeline stages"
```

---

### Task 10: The render reads the channel's brand

**Files:**
- Modify: `src/services/render.service.ts`
- Test: `src/services/render.service.test.ts`

**Interfaces:**
- Consumes: `brandService.resolve` (Task 1).
- Produces: no new exports. This is the task that makes `ChannelBrand.videoStyle`
  and `musicQuery` actually do something — without it they are stored and
  ignored.

- [ ] **Step 1: Write the failing tests**

```typescript
  it("renders with the channel's own style, not the default", async () => {
    const videoId = await makeRenderableVideo();
    const channelId = await assignChannelWithBrand({
      videoStyle: { transitions: { durationSeconds: 0.25 } },
    });

    const { spawner, calls } = createSpawner(async (child, args) => {
      await writeFile(args[args.length - 1], "fake-rendered-mp4-bytes");
      child.emit("close", 0);
    });
    await new RenderService(spawner).render(userId, videoId);

    // A stub is built at the brand's crossfade length, not DEFAULT_STYLE's.
    const stub = calls.find((call) => call.args.join(" ").includes("xfade"));
    expect(stub!.args.join(" ")).toContain("duration=0.25");
  });

  it("searches for music the channel chose, not the video's title", async () => {
    // A title is not a musical description — searching Jamendo for
    // "Ada Lovelace wrote the first program" is why a real render found no
    // usable bed.
    const videoId = await makeRenderableVideo();
    await assignChannelWithBrand({ musicQuery: "calm ambient documentary" });

    const search = vi.fn().mockResolvedValue([]);
    // MusicService is injected into RenderService for this test.
    await renderWith({ videoId, musicSearch: search });

    expect(search.mock.calls[0][0]).toBe("calm ambient documentary");
  });

  it("falls back to defaults for a video whose project has no channel", async () => {
    // Every existing video renders exactly as it does today.
  });
```

Write `assignChannelWithBrand` as a fixture helper that connects a channel,
assigns it to the video's project, and creates the `ChannelBrand` row.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/services/render.service.test.ts -t "channel's own style"`
Expected: FAIL — the render reads `DEFAULT_STYLE` directly

- [ ] **Step 3: Implement**

In `src/services/render.service.ts`, replace `const style = DEFAULT_STYLE` with
a `brandService.resolve(channelId)` call, taking `channelId` from the video's
project (already selected for other purposes). Use `brand.videoStyle` where
`style` is used now, and pass `brand.musicQuery` to `musicService.collect`
instead of `video.title`.

Keep `DEFAULT_STYLE` imported — `brandService.resolve` returns it for an
unbranded channel, so the fallback lives in one place rather than two.

- [ ] **Step 4: Run the render suite**

Run: `npx vitest run src/services/render.service.test.ts`
Expected: PASS — every existing test plus 3 new

- [ ] **Step 5: Typecheck, lint and commit**

```bash
pnpm typecheck && pnpm lint
git add src/services/render.service.ts src/services/render.service.test.ts
git commit -m "feat: render each channel in its own style"
```

---

## Verification

After Task 10, with the worker redeployed:

- Set a channel's brand — tone, niche, colours, music query — and generate a logo.
- Render one video end to end and confirm the pipeline shows seven stages, with
  metadata and thumbnail both green.
- Confirm the video reaches `READY` with a generated title, a description, tags,
  and a thumbnail that has readable text and the logo in a corner.
- Publish it as `PRIVATE` and confirm on YouTube that the title, description,
  tags and thumbnail all arrived.
- Confirm the music bed now matches the channel's `musicQuery` rather than the
  video's title.

Run `pnpm verify` with the worker stopped — a running worker claims the test
suite's videos out of the same database and makes a green run untrustworthy.
