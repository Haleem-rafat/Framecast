# First Video (Walking Skeleton) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn an approved script into an MP4 uploaded unlisted to the operator's YouTube channel, with visible per-stage progress.

**Architecture:** Five stages — narration, footage, captions, render, upload — each a service method keyed on `videoId` with no dependency on where the process runs. Orchestrated by a local CLI (`pnpm render <videoId>`) rather than a worker, so the riskiest unknown (FFmpeg assembly) is proven before any infrastructure is built around it. Extraction to a worker later is mechanical.

**Tech Stack:** Next.js 15, TypeScript, Prisma 7 + Supabase Postgres, Supabase Storage, ElevenLabs (TTS with character timestamps), Pexels + Pixabay (stock video), FFmpeg 8.0.1 local, YouTube Data API v3, Vitest, TanStack Query.

## Global Constraints

- **Every service file starts with `import "server-only";`** — except pure-function modules in `src/lib/` that do no I/O (`captions.ts`, `ffmpeg-command.ts`), matching `prompt-template.ts` and `cost.ts`.
- **Every query is scoped by `userId`** and filters `deletedAt: null` on soft-deletable models.
- **Service tests create their own throwaway `User`** via the fixture helper in `src/test/`. Never `prisma.user.findFirstOrThrow()` — that destroyed a real operator credential once already.
- **Secrets never reach the client.** Explicit Prisma `select` on every read that touches a credential or token.
- **Providers are injected** into services, as `ScriptService` does, so tests never hit the network or spend quota.
- **Errors are typed** (`src/lib/errors.ts`). Provider failures wrap in `ProviderError(provider, message, retryable)` with `retryable` from the HTTP status (429 and 5xx retryable). The provider label must be truthful — `"ELEVENLABS"`, `"PEXELS"`, `"PIXABAY"`, `"YOUTUBE"`.
- **Status transitions are atomic conditional updates** guarded on the current status, with a `VideoStatusEvent` appended in the same transaction. Gate 1's first implementation had a check-then-act race; do not reproduce that shape.
- **Upload is always `unlisted`.** No public option exists in this plan.
- **Never run `pnpm build`** while the operator's dev server is running — it writes a production `.next` and breaks their browser.
- Node 24+, pnpm, commands from the repo root.

---

## File Structure

**Create:**

| Path | Responsibility |
|---|---|
| `src/lib/storage.ts` | Supabase Storage upload/download/signed URL |
| `src/lib/captions.ts` | Character alignment → SRT. Pure. |
| `src/lib/ffmpeg-command.ts` | Build the FFmpeg argument list. Pure. |
| `src/services/providers/elevenlabs.provider.ts` | TTS with timestamps |
| `src/services/providers/stock-footage.provider.ts` | Pexels + Pixabay search |
| `src/services/voiceover.service.ts` | Narration stage |
| `src/services/footage.service.ts` | Footage stage |
| `src/services/render.service.ts` | Render stage, spawns FFmpeg, writes progress |
| `src/services/publish.service.ts` | Upload stage + Gate 2 |
| `src/services/pipeline.service.ts` | Read model for the progress panel |
| `scripts/render.ts` | The CLI |
| `src/features/videos/components/pipeline-panel.tsx` | Progress UI |

**Modify:** `src/config/env.ts` · `.env.example` · `package.json` · `src/app/(dashboard)/videos/[id]/page.tsx`

---

### Task 1: Supabase Storage

Nothing is stored yet. Audio, clips, captions and the finished MP4 all need somewhere to live.

**Files:**
- Create: `src/lib/storage.ts`, `src/lib/storage.test.ts`
- Modify: `src/config/env.ts`, `.env.example`

**Interfaces:**
- Produces: `storagePath(videoId, kind, filename): string`, `putObject(path, body, contentType): Promise<string>`, `getObject(path): Promise<Buffer>`, `signedUrl(path, expiresInSeconds): Promise<string>`, `ensureBucket(): Promise<void>`

- [ ] **Step 1: Confirm the required env vars are already validated**

`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_STORAGE_BUCKET` already exist in `src/config/env.ts`. The first two are `.optional()`. Storage is now required, so tighten them: remove `.optional()` from both, and add them to the production checklist in `.env.example` if not already described.

Run: `pnpm typecheck` — expect errors anywhere the optionality was relied on, and fix those.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { storagePath } from "@/lib/storage";

describe("storagePath", () => {
  it("namespaces by video and kind", () => {
    expect(storagePath("abc-123", "audio", "narration.mp3")).toBe(
      "videos/abc-123/audio/narration.mp3",
    );
  });

  it("rejects a filename that would escape the prefix", () => {
    expect(() => storagePath("abc-123", "audio", "../../etc/passwd")).toThrow();
  });

  it("rejects an empty filename", () => {
    expect(() => storagePath("abc-123", "audio", "")).toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test src/lib/storage.test.ts`
Expected: FAIL — `Cannot find module '@/lib/storage'`

- [ ] **Step 4: Implement `src/lib/storage.ts`**

```ts
import "server-only";

import { createClient } from "@supabase/supabase-js";

import { env } from "@/config/env";
import { InternalError, ValidationError } from "@/lib/errors";

export type StorageKind = "audio" | "clips" | "captions" | "output";

const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

/**
 * Every object lives under its video's prefix so deleting a video's assets is a
 * prefix delete. Filenames are validated rather than sanitised: a name that
 * would escape the prefix is a bug in the caller, not something to quietly fix.
 */
export function storagePath(
  videoId: string,
  kind: StorageKind,
  filename: string,
): string {
  if (!filename || filename.includes("/") || filename.includes("..")) {
    throw new ValidationError(`Unsafe storage filename: "${filename}"`);
  }

  return `videos/${videoId}/${kind}/${filename}`;
}

/** Idempotent. Safe to call on every render. */
export async function ensureBucket(): Promise<void> {
  const { data } = await client.storage.getBucket(env.SUPABASE_STORAGE_BUCKET);

  if (data) {
    return;
  }

  // Private: rendered videos and narration are the operator's unpublished work.
  const { error } = await client.storage.createBucket(
    env.SUPABASE_STORAGE_BUCKET,
    { public: false },
  );

  if (error) {
    throw new InternalError(`Could not create storage bucket: ${error.message}`);
  }
}

export async function putObject(
  path: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  const { error } = await client.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .upload(path, body, { contentType, upsert: true });

  if (error) {
    throw new InternalError(`Upload failed for ${path}: ${error.message}`);
  }

  return path;
}

export async function getObject(path: string): Promise<Buffer> {
  const { data, error } = await client.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .download(path);

  if (error || !data) {
    throw new InternalError(`Download failed for ${path}: ${error?.message}`);
  }

  return Buffer.from(await data.arrayBuffer());
}

/** The bucket is private, so anything shown in the browser needs a signed URL. */
export async function signedUrl(
  path: string,
  expiresInSeconds = 3600,
): Promise<string> {
  const { data, error } = await client.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .createSignedUrl(path, expiresInSeconds);

  if (error || !data) {
    throw new InternalError(`Could not sign ${path}: ${error?.message}`);
  }

  return data.signedUrl;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test src/lib/storage.test.ts`
Expected: PASS — 3 tests

- [ ] **Step 6: Verify against the real bucket, by hand**

Write a throwaway script that calls `ensureBucket()`, then `putObject` / `getObject` / `signedUrl` on a small text file, and confirms the round-trip. Delete the script and the object afterwards. Paste the output into your report — a storage layer that typechecks but cannot reach Supabase is worthless, and no unit test will tell you.

- [ ] **Step 7: Commit**

```bash
git add src/lib/storage.ts src/lib/storage.test.ts src/config/env.ts .env.example
git commit -m "feat: add Supabase Storage helpers"
```

---

### Task 2: Caption builder

Written before narration because it is a pure function that narration's output feeds, and it is the piece most likely to be subtly wrong.

**Files:**
- Create: `src/lib/captions.ts`, `src/lib/captions.test.ts`

**Interfaces:**
- Produces: `type Alignment = { characters: string[]; characterStartTimesSeconds: number[]; characterEndTimesSeconds: number[] }`, `buildSrt(alignment: Alignment, maxWordsPerLine?: number): string`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { buildSrt, type Alignment } from "@/lib/captions";

/** Builds an alignment where every character takes exactly 0.1s. */
function evenAlignment(text: string): Alignment {
  const characters = [...text];
  return {
    characters,
    characterStartTimesSeconds: characters.map((_, i) => i * 0.1),
    characterEndTimesSeconds: characters.map((_, i) => (i + 1) * 0.1),
  };
}

describe("buildSrt", () => {
  it("emits numbered cues with SRT timestamps", () => {
    const srt = buildSrt(evenAlignment("hello world"), 2);

    expect(srt).toContain("1\n");
    expect(srt).toMatch(/\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/);
    expect(srt).toContain("hello world");
  });

  it("breaks into multiple cues past the word limit", () => {
    const srt = buildSrt(evenAlignment("one two three four"), 2);

    expect(srt).toContain("1\n");
    expect(srt).toContain("2\n");
  });

  it("starts the first cue at the first character's time", () => {
    expect(buildSrt(evenAlignment("hi"), 5)).toContain("00:00:00,000 -->");
  });

  it("breaks at sentence end even below the word limit", () => {
    const srt = buildSrt(evenAlignment("Stop. Go on now"), 10);

    // "Stop." should close its own cue rather than running into "Go".
    expect(srt.split("\n\n").filter(Boolean).length).toBeGreaterThan(1);
  });

  it("returns an empty string for an empty alignment", () => {
    expect(
      buildSrt({ characters: [], characterStartTimesSeconds: [], characterEndTimesSeconds: [] }),
    ).toBe("");
  });

  it("formats hours, minutes and milliseconds correctly", () => {
    const characters = ["a", "b"];
    const srt = buildSrt({
      characters,
      characterStartTimesSeconds: [3661.5, 3661.6],
      characterEndTimesSeconds: [3661.6, 3661.75],
    });

    expect(srt).toContain("01:01:01,500 --> 01:01:01,750");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/captions.test.ts`
Expected: FAIL — `Cannot find module '@/lib/captions'`

- [ ] **Step 3: Implement `src/lib/captions.ts`**

```ts
export interface Alignment {
  characters: string[];
  characterStartTimesSeconds: number[];
  characterEndTimesSeconds: number[];
}

interface Word {
  text: string;
  start: number;
  end: number;
}

const DEFAULT_MAX_WORDS = 6;

/** SRT wants `HH:MM:SS,mmm` — comma, not the period WebVTT uses. */
function timestamp(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;

  return (
    `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:` +
    `${String(s).padStart(2, "0")},${String(milli).padStart(3, "0")}`
  );
}

/**
 * ElevenLabs aligns per character, but captions read as words. Whitespace closes
 * the current word and is not itself timed.
 */
function toWords(alignment: Alignment): Word[] {
  const words: Word[] = [];
  let current: Word | null = null;

  alignment.characters.forEach((char, index) => {
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = null;
      }
      return;
    }

    if (!current) {
      current = {
        text: char,
        start: alignment.characterStartTimesSeconds[index] ?? 0,
        end: alignment.characterEndTimesSeconds[index] ?? 0,
      };
      return;
    }

    current.text += char;
    current.end = alignment.characterEndTimesSeconds[index] ?? current.end;
  });

  if (current) {
    words.push(current);
  }

  return words;
}

export function buildSrt(
  alignment: Alignment,
  maxWordsPerLine: number = DEFAULT_MAX_WORDS,
): string {
  const words = toWords(alignment);

  if (words.length === 0) {
    return "";
  }

  const cues: Word[][] = [];
  let line: Word[] = [];

  for (const word of words) {
    line.push(word);

    // Sentence-final punctuation is a better break than a word count: a cue that
    // ends mid-sentence reads worse than a short one.
    const endsSentence = /[.!?]$/.test(word.text);

    if (endsSentence || line.length >= maxWordsPerLine) {
      cues.push(line);
      line = [];
    }
  }

  if (line.length > 0) {
    cues.push(line);
  }

  return (
    cues
      .map((cue, index) => {
        const text = cue.map((word) => word.text).join(" ");
        const start = timestamp(cue[0].start);
        const end = timestamp(cue[cue.length - 1].end);

        return `${index + 1}\n${start} --> ${end}\n${text}\n`;
      })
      .join("\n") + "\n"
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/captions.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/lib/captions.ts src/lib/captions.test.ts
git commit -m "feat: build SRT captions from character alignment"
```

---

### Task 3: FFmpeg command builder

Also pure, also written before the thing that uses it. An FFmpeg invocation is easy to get wrong and hard to debug once it is buried inside a process spawn.

**Files:**
- Create: `src/lib/ffmpeg-command.ts`, `src/lib/ffmpeg-command.test.ts`

**Interfaces:**
- Produces: `buildRenderArgs(input: RenderInput): string[]` where `RenderInput = { clipPaths: string[]; audioPath: string; srtPath: string; outputPath: string; durationSeconds: number; clipSeconds?: number }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { buildRenderArgs } from "@/lib/ffmpeg-command";

const base = {
  clipPaths: ["/tmp/a.mp4", "/tmp/b.mp4"],
  audioPath: "/tmp/narration.mp3",
  srtPath: "/tmp/captions.srt",
  outputPath: "/tmp/out.mp4",
  durationSeconds: 30,
};

describe("buildRenderArgs", () => {
  it("includes every clip as an input", () => {
    const args = buildRenderArgs(base);
    expect(args.filter((a) => a === "-i")).toHaveLength(3); // 2 clips + audio
  });

  it("cuts the output to the narration duration", () => {
    const args = buildRenderArgs(base);
    expect(args).toContain("-t");
    expect(args[args.indexOf("-t") + 1]).toBe("30");
  });

  it("burns in the subtitle file", () => {
    expect(buildRenderArgs(base).join(" ")).toContain("subtitles=");
  });

  it("encodes h264 and aac", () => {
    const args = buildRenderArgs(base).join(" ");
    expect(args).toContain("libx264");
    expect(args).toContain("aac");
  });

  it("emits machine-readable progress", () => {
    const args = buildRenderArgs(base);
    expect(args).toContain("-progress");
  });

  it("puts the output path last", () => {
    expect(buildRenderArgs(base).at(-1)).toBe("/tmp/out.mp4");
  });

  it("refuses to build with no clips", () => {
    expect(() => buildRenderArgs({ ...base, clipPaths: [] })).toThrow();
  });

  it("escapes a subtitle path containing special characters", () => {
    const args = buildRenderArgs({ ...base, srtPath: "/tmp/my captions.srt" });
    // The filter graph must not break on the space.
    expect(args.join(" ")).toContain("my\\ captions.srt");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/ffmpeg-command.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/lib/ffmpeg-command.ts`**

```ts
import { ValidationError } from "@/lib/errors";

export interface RenderInput {
  clipPaths: string[];
  audioPath: string;
  srtPath: string;
  outputPath: string;
  /** Cut the result to exactly this, so video and narration cannot drift. */
  durationSeconds: number;
  clipSeconds?: number;
}

const WIDTH = 1920;
const HEIGHT = 1080;
const DEFAULT_CLIP_SECONDS = 12;

/**
 * FFmpeg's filter graph parser treats `:` and `'` as syntax, so a path inside
 * `subtitles=` has to be escaped even though the shell never sees it — args are
 * passed to spawn as an array.
 */
function escapeForFilter(path: string): string {
  return path.replace(/([\\:'[\],; ])/g, "\\$1");
}

export function buildRenderArgs(input: RenderInput): string[] {
  if (input.clipPaths.length === 0) {
    throw new ValidationError("Cannot render without at least one clip.");
  }

  const clipSeconds = input.clipSeconds ?? DEFAULT_CLIP_SECONDS;
  const args: string[] = ["-y"];

  for (const clip of input.clipPaths) {
    // Loop each clip so a short one still fills its slot rather than freezing.
    args.push("-stream_loop", "-1", "-t", String(clipSeconds), "-i", clip);
  }

  args.push("-i", input.audioPath);

  // Scale to fill, centre-crop the overflow, force a constant frame rate so the
  // concat filter does not have to reconcile mismatched timebases.
  const perClip = input.clipPaths
    .map(
      (_, i) =>
        `[${i}:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,` +
        `crop=${WIDTH}:${HEIGHT},fps=30,setsar=1[v${i}]`,
    )
    .join(";");

  const concatInputs = input.clipPaths.map((_, i) => `[v${i}]`).join("");
  const audioIndex = input.clipPaths.length;

  const filter =
    `${perClip};${concatInputs}concat=n=${input.clipPaths.length}:v=1:a=0[vcat];` +
    `[vcat]subtitles=${escapeForFilter(input.srtPath)}[vout]`;

  args.push(
    "-filter_complex", filter,
    "-map", "[vout]",
    "-map", `${audioIndex}:a`,
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "22",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-shortest",
    "-t", String(Math.round(input.durationSeconds)),
    // Machine-readable progress on stdout so the runner can report a real
    // percentage instead of a decorative one.
    "-progress", "pipe:1",
    "-nostats",
    input.outputPath,
  );

  return args;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/ffmpeg-command.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: Prove the command actually renders**

A passing unit test proves the argument list has the right shape, not that FFmpeg accepts it. Build a real 5-second render by hand:

1. Download two short clips from Pexels with `curl`
2. Make a short MP3 with `ffmpeg -f lavfi -i "sine=frequency=440:duration=5" /tmp/tone.mp3`
3. Write a two-cue SRT by hand
4. Run `ffmpeg` with the args your function returns
5. Confirm the output plays, has audio, and shows captions

Paste FFmpeg's final output line into your report. If the filter graph is wrong, this is where you find out — not in Task 5 with three other things in flight.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ffmpeg-command.ts src/lib/ffmpeg-command.test.ts
git commit -m "feat: build the FFmpeg render command"
```

---

### Task 4: Narration

**Files:**
- Create: `src/services/providers/elevenlabs.provider.ts`, `src/services/voiceover.service.ts`, `src/services/voiceover.service.test.ts`
- Modify: `src/config/env.ts`, `.env.example`

**Interfaces:**
- Consumes: `storagePath`/`putObject` (Task 1), `Alignment` (Task 2), `providerCredentialService.resolveKey` (existing)
- Produces: `SpeechProvider` interface with `synthesize(input: { text: string; voiceId: string; apiKey: string }): Promise<{ audio: Buffer; alignment: Alignment; characterCount: number }>`
- Produces: `voiceOverService.generate(userId, videoId, opts?: { force?: boolean }): Promise<{ durationSeconds: number; characterCount: number }>`

- [ ] **Step 1: Add the voice setting to env**

```ts
  /** ElevenLabs voice. Default is Roger — American, conversational. */
  ELEVENLABS_VOICE_ID: z.string().min(1).default("CwhRBWXzGAHq8TQ4Fs17"),
  ELEVENLABS_MODEL_ID: z.string().min(1).default("eleven_turbo_v2_5"),
```

Add both to `.env.example` with a comment noting the voice list is at `GET /v1/voices`.

- [ ] **Step 2: Write the failing test**

The provider is injected, so no network call happens. Use the shared throwaway-user fixture.

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { VoiceOverService } from "@/services/voiceover.service";

// ... create a throwaway user, project, video with an approved script ...

const fakeProvider = {
  synthesize: vi.fn(async () => ({
    audio: Buffer.from("fake-mp3-bytes"),
    alignment: {
      characters: [..."hello"],
      characterStartTimesSeconds: [0, 0.1, 0.2, 0.3, 0.4],
      characterEndTimesSeconds: [0.1, 0.2, 0.3, 0.4, 0.5],
    },
    characterCount: 5,
  })),
};

describe("voiceOverService.generate", () => {
  it("stores the audio and records duration", async () => { /* ... */ });

  it("persists the alignment as an Asset so captions can be rebuilt", async () => { /* ... */ });

  it("refuses to re-synthesise when a VoiceOver already exists", async () => {
    // The operator is on a 10,000 character/month free tier and one script is
    // ~7,000. A silent re-run would burn the month.
    await service.generate(userId, videoId);
    fakeProvider.synthesize.mockClear();
    await expect(service.generate(userId, videoId)).rejects.toThrow(ConflictError);
    expect(fakeProvider.synthesize).not.toHaveBeenCalled();
  });

  it("re-synthesises when force is passed", async () => { /* ... */ });

  it("refuses when the video has no approved script", async () => { /* ... */ });

  it("writes a ProviderUsage row recording the character count", async () => { /* ... */ });
});
```

Write these out in full, following `script.service.test.ts` for fixture shape.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test src/services/voiceover.service.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement the provider**

`POST https://api.elevenlabs.io/v1/text-to-speech/{voiceId}/with-timestamps`, header `xi-api-key`, body `{ text, model_id }`. The response is JSON with `audio_base64` and `alignment` (`characters`, `character_start_times_seconds`, `character_end_times_seconds`). Decode base64 to a Buffer. Map snake_case to the camelCase `Alignment` shape at this boundary so nothing downstream deals with two conventions.

Wrap failures in `ProviderError("ELEVENLABS", …, retryable)` with `retryable` true for 429 and 5xx. Never include the API key in an error message.

- [ ] **Step 5: Implement the service**

Load the video scoped by `userId`, assert status is `QUEUED`, assert an active `ScriptVersion` exists. Refuse if a `VoiceOver` row already exists unless `force`. Resolve the key with `providerCredentialService.resolveKey(userId, "ELEVENLABS")` and throw `ProviderError` if absent.

In one transaction: upsert `VoiceOver` with `audioUrl`, `durationSeconds` (last `characterEndTimesSeconds` value), `voiceId`, `voiceName`, `provider`; create an `Asset` of kind `SUBTITLE` holding the raw alignment JSON; write `ProviderUsage` with `operation: "voiceover.generate"` and the character count in `inputTokens`; write `ActivityLog`.

Upload the MP3 **before** opening the transaction — a storage call inside a database transaction holds the connection open for the length of a network round trip.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test src/services/voiceover.service.test.ts && pnpm typecheck`

- [ ] **Step 7: Commit**

```bash
git add src/services/providers/elevenlabs.provider.ts src/services/voiceover.service.ts src/services/voiceover.service.test.ts src/config/env.ts .env.example
git commit -m "feat: generate narration with character-level timestamps"
```

---

### Task 5: Footage

**Files:**
- Create: `src/services/providers/stock-footage.provider.ts`, `src/services/footage.service.ts`, `src/services/footage.service.test.ts`
- Modify: `src/config/env.ts`, `.env.example`

**Interfaces:**
- Produces: `StockFootageProvider` with `search(query: string, count: number): Promise<StockClip[]>` where `StockClip = { source: "PEXELS" | "PIXABAY"; externalId: string; url: string; width: number; height: number; durationSeconds: number }`
- Produces: `footageService.collect(userId, videoId): Promise<{ clipCount: number; bySource: Record<string, number> }>`

- [ ] **Step 1: Add the keys to env**

```ts
  PEXELS_API_KEY: z.string().min(1).optional(),
  PIXABAY_API_KEY: z.string().min(1).optional(),
```

Optional so the app still boots without them; the footage service throws a clear `ProviderError` if both are missing.

- [ ] **Step 2: Write the failing test**

Cover, with an injected provider: clip count is `ceil(duration / 12) + 2`; sources alternate; the same `externalId` is never used twice in one video; each clip becomes an `Asset` of kind `VIDEO` with a `storagePath`; re-running does not duplicate assets; a video with no `VoiceOver` is refused, since clip count depends on the narration's duration.

- [ ] **Step 3: Run test to verify it fails**

- [ ] **Step 4: Implement the provider**

**Pexels:** `GET https://api.pexels.com/videos/search?query=&per_page=&orientation=landscape`, header `Authorization: <key>`. Pick the largest `video_files` entry whose `width` is ≤ 1920 to avoid downloading 4K for a 1080p render.

**Pixabay:** `GET https://pixabay.com/api/videos/?key=&q=&per_page=`. Prefer `videos.medium`, falling back to `videos.small`.

Both must be downloaded to storage — Pixabay's terms forbid permanent hotlinking, and an expiring CDN URL would fail mid-render.

Search terms come from the video's `topic`, trimmed to Pixabay's 100-character limit.

- [ ] **Step 5: Implement the service**

Require a `VoiceOver`. Compute the clip count from its duration. Alternate providers, skipping duplicates by `externalId`. Download each and `putObject` under `storagePath(videoId, "clips", …)`. Insert one `Asset` per clip with `kind: "VIDEO"`, `provider`, and `storagePath`. Idempotent: an existing asset for the same `externalId` is skipped rather than re-downloaded.

- [ ] **Step 6: Run tests, then verify against the real APIs by hand**

Fetch three real clips for a finance query, confirm they land in storage and play. Paste the file sizes into your report.

- [ ] **Step 7: Commit**

```bash
git add src/services/providers/stock-footage.provider.ts src/services/footage.service.ts src/services/footage.service.test.ts src/config/env.ts .env.example
git commit -m "feat: collect stock footage from Pexels and Pixabay"
```

---

### Task 6: Render

**Files:**
- Create: `src/services/render.service.ts`, `src/services/render.service.test.ts`

**Interfaces:**
- Consumes: `buildRenderArgs` (Task 3), `getObject`/`putObject` (Task 1), `buildSrt` (Task 2)
- Produces: `renderService.render(userId, videoId): Promise<{ outputPath: string; durationSeconds: number }>`

- [ ] **Step 1: Write the failing test**

Inject the process spawner so no FFmpeg runs in tests. Cover: a `RenderJob` is created and moves `QUEUED → RUNNING → SUCCEEDED`; `progress` is written as the parsed `out_time_ms` advances; a non-zero exit sets `FAILED` and writes stderr to `RenderLog`; the video's status moves `GENERATING → RENDERING → READY`; a second concurrent render is refused rather than starting twice.

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement**

Download the narration, clips and captions from storage to a temporary directory. Write the SRT from the persisted alignment via `buildSrt`. Build args with `buildRenderArgs`. Spawn `ffmpeg` with `spawn("ffmpeg", args)` — **never** a shell string, so a path with a space or quote cannot become an injection.

Parse `-progress` output from stdout: lines of `key=value`, with `out_time_ms` giving elapsed microseconds. Percentage is `out_time_ms / 1000 / durationSeconds / 1000`. Throttle writes to `RenderJob.progress` to at most one per second — FFmpeg emits progress far faster than a database should be written.

Collect stderr and write it to `RenderLog` in batches, not per line.

Upload the MP4 to `storagePath(videoId, "output", "video.mp4")`, set `RenderJob.outputUrl`, and transition the video to `READY` with a `VideoStatusEvent`, using the same atomic conditional-update shape as `approveScript`.

Clean up the temporary directory in a `finally`.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/services/render.service.ts src/services/render.service.test.ts
git commit -m "feat: render video with FFmpeg and report progress"
```

---

### Task 7: Upload and Gate 2

**Files:**
- Create: `src/services/publish.service.ts`, `src/services/publish.service.test.ts`, `src/actions/publish.action.ts`
- Modify: `src/services/channel.service.ts` (add token refresh)

**Interfaces:**
- Produces: `publishService.publish(userId, videoId): Promise<{ youtubeVideoId: string }>`

- [ ] **Step 1: Add refresh-token exchange to `channel.service.ts`**

`resolveAccessToken` currently returns the stored access token unchanged. Google's access tokens expire after about an hour, so an upload minutes after connecting works and one an hour later does not — a failure that looks intermittent and is not.

Exchange the refresh token at `POST https://oauth2.googleapis.com/token` with `grant_type=refresh_token` when `tokenExpiresAt` is within 5 minutes, persist the new access token **encrypted**, and return it. This was recorded as deferred when Task 3b shipped; it is now load-bearing.

- [ ] **Step 2: Write the failing test**

Cover: Gate 2 refuses unless the video is `READY` with a `RenderJob.outputUrl`; two concurrent publishes produce exactly one `Publication` and one `VideoStatusEvent`; `privacyStatus` is always `unlisted`; the description contains the script's SOURCES section and a Pixabay credit; a failed upload sets `FAILED` without creating a `Publication`.

- [ ] **Step 3: Run test to verify it fails**

- [ ] **Step 4: Implement**

Resumable upload: `POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status` with the metadata, then `PUT` the bytes to the returned `Location`.

```ts
status: { privacyStatus: "unlisted", selfDeclaredMadeForKids: false }
```

`unlisted` is not configurable. Free-tier ElevenLabs audio carries no commercial rights, and an automated channel publishing publicly by accident is expensive to undo.

Gate 2 uses the same atomic conditional update as Gate 1.

- [ ] **Step 5: Run tests to verify they pass**

- [ ] **Step 6: Commit**

```bash
git add src/services/publish.service.ts src/services/publish.service.test.ts src/actions/publish.action.ts src/services/channel.service.ts
git commit -m "feat: upload to YouTube unlisted behind Gate 2"
```

---

### Task 8: The CLI

**Files:**
- Create: `scripts/render.ts`
- Modify: `package.json`

- [ ] **Step 1: Implement `scripts/render.ts`**

```
pnpm render <videoId> [--force-narration]
```

Loads `.env.local` then `.env` exactly as `prisma.config.ts` does. Resolves the operator by `SEED_USER_EMAIL`. Runs `ensureBucket`, then narration → footage → render, printing each stage and its elapsed time. Stops before publishing: Gate 2 is a human decision made in the UI, not a flag.

Exit non-zero on failure and print the failure reason. Skip stages already complete so a re-run resumes rather than restarting — with narration especially, since re-running it costs quota.

- [ ] **Step 2: Add the script**

```json
    "render": "tsx scripts/render.ts",
```

- [ ] **Step 3: Verify end to end, for real**

This is the task the whole plan exists for. On a video with an approved script:

```bash
pnpm render <videoId>
```

Confirm: narration downloads and plays; clips land in storage; the MP4 exists, plays, has audio in sync, and shows captions; the video reaches `READY`. Paste the CLI output and the output file size into your report.

- [ ] **Step 4: Commit**

```bash
git add scripts/render.ts package.json
git commit -m "feat: add the render CLI"
```

---

### Task 9: Progress panel

**Files:**
- Create: `src/services/pipeline.service.ts`, `src/services/pipeline.service.test.ts`, `src/features/videos/components/pipeline-panel.tsx`
- Modify: `src/app/(dashboard)/videos/[id]/page.tsx`, `src/actions/video.action.ts`

**Interfaces:**
- Produces: `pipelineService.getState(userId, videoId): Promise<PipelineState>` with a stage list of `{ key, status: "pending" | "running" | "done" | "failed", detail?: string }`, plus `progress`, `isTerminal`, and recent log lines

- [ ] **Step 1: Write the failing test**

Derive stage state from real rows: narration `done` once a `VoiceOver` exists; footage `done` once `Asset` rows of kind `VIDEO` exist; render `running` while a `RenderJob` is `RUNNING`, carrying its percentage; upload `done` once a `Publication` exists; any stage `failed` when the video is `FAILED`. `isTerminal` is true for `READY`, `PUBLISHED` and `FAILED` — the client stops polling on it.

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement the service and the action**

One query with the necessary `include`s. Return only what the panel renders — no tokens, no storage paths that would let a client bypass signed URLs.

- [ ] **Step 4: Implement the panel**

Client component using TanStack Query with `refetchInterval: (query) => query.state.data?.isTerminal ? false : 2000`. **Polling must stop on a terminal state** — an interval that never clears is a request every 2 seconds forever on an idle tab.

Render the stage list with pending/running/done/failed, a progress bar for the render stage, elapsed time, and the last 20 `RenderLog` lines in a collapsed block.

- [ ] **Step 5: Verify by hand**

Start a render and watch the panel move through the stages. Confirm polling stops when it finishes — check the network tab. Paste what you observed.

- [ ] **Step 6: Commit**

```bash
git add src/services/pipeline.service.ts src/services/pipeline.service.test.ts src/features/videos/components/pipeline-panel.tsx src/app/\(dashboard\)/videos/\[id\]/page.tsx src/actions/video.action.ts
git commit -m "feat: show live pipeline progress on the video page"
```

---

## Done when

- [ ] `pnpm render <videoId>` produces an MP4 that plays, with narration in sync and captions burned in
- [ ] The video reaches `READY` and the operator can publish it from the UI
- [ ] It appears on the channel, **unlisted**
- [ ] Re-running the CLI does not re-synthesise existing narration
- [ ] The pipeline panel tracks a real render and stops polling when it ends
- [ ] The description credits Pixabay and carries the script's sources
- [ ] `pnpm typecheck` and `pnpm test` pass
- [ ] The operator can list what is wrong with the video — that list is sub-project 2's backlog
