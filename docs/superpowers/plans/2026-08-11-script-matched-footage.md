# Script-Matched Footage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each stretch of narration show footage chosen for what it is
actually saying, changing when the topic changes rather than on a timer.

**Architecture:** The script model returns narration split into sections, each
with a b-roll cue. Narration is stored exactly as today; cues go in a new
nullable `ScriptVersion.cues` column, anchored to the first eight words of
their section so they survive operator edits. Footage collection searches once
per cue and stores one clip per section. Render converts each cue's character
range into a time range using the narration alignment that captions already
use, so `ensureCoverage`'s clip looping is deleted rather than extended.

**Tech Stack:** TypeScript, Next.js 15, Prisma 7 (PostgreSQL/Supabase), Vitest,
AI SDK v7 (`ai@^7.0.58`) via Vercel AI Gateway, Zod v4 (`zod@^4.4.3`), FFmpeg.

**Spec:** `docs/superpowers/specs/2026-08-11-script-matched-footage-design.md`

## Global Constraints

- Every test creates its own throwaway user via `src/test/fixtures.ts`. **NEVER
  call `prisma.user.findFirstOrThrow()`** — a test once destroyed the
  operator's real ElevenLabs credential that way.
- Tests run against a REMOTE Supabase database shared with the operator's real
  data. Never delete or modify rows you did not create.
- The repository is PUBLIC. No secrets in code, tests, or commit messages.
- `pnpm typecheck` and `pnpm lint` must pass before every commit.
- Never publish to YouTube from a test or script.
- `ScriptVersion.cues` is nullable with no backfill. Every existing script must
  keep rendering exactly as it does today.
- Anchors are the **first eight words** of a section, verbatim.
- Anchor search is **ordered**: each search begins where the previous anchor
  ended.
- Pexels is searched per cue; Pixabay only when Pexels returns nothing usable.
- Section clip storage path: `videos/{videoId}/clips/section-{NNN}.mp4`,
  zero-padded to three digits.

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` | Adds nullable `cues Json?` to `ScriptVersion` |
| `src/lib/script-cues.ts` (new) | Pure functions: anchor extraction, ordered re-anchoring, cue→character-range, character-range→time-range |
| `src/lib/script-cues.test.ts` (new) | Unit tests for the above — no database, no network |
| `src/services/providers/types.ts` | Adds `ScriptSection` and `sections` to `ScriptGenerationResult` |
| `src/services/providers/gateway.provider.ts` | Switches script generation to `generateObject` with a Zod schema |
| `src/services/script.service.ts` | Stores `cues` on generate; re-anchors on `saveEdit` |
| `src/services/footage.service.ts` | Per-cue search, per-section storage paths, fallback pool |
| `src/services/render.service.ts` | Cue→time ranges, variable-length segments, deletes `ensureCoverage` |
| `src/lib/ffmpeg-command.ts` | `planRender` takes per-segment durations |

`src/lib/script-cues.ts` is deliberately pure and database-free: anchoring and
timing are the two places this feature can be subtly wrong, and they are much
easier to test in isolation than through a pipeline.

---

### Task 1: Cue anchoring and timing primitives

Pure functions with no database or network. Everything else in this plan
depends on them, and they are where the correctness risk lives.

**Files:**
- Create: `src/lib/script-cues.ts`
- Test: `src/lib/script-cues.test.ts`

**Interfaces:**
- Consumes: `Alignment` from `src/lib/captions.ts` — the shape is
  `{ characters: string[]; characterStartTimesSeconds: number[]; characterEndTimesSeconds: number[] }`
- Produces:
  - `extractAnchor(sectionText: string): string`
  - `type ScriptCue = { anchor: string; cue: string }`
  - `type AnchoredCue = { cue: string; startChar: number; endChar: number }`
  - `anchorCues(cues: ScriptCue[], content: string): { anchored: AnchoredCue[]; orphaned: ScriptCue[] }`
  - `type CueWindow = { cue: string; startSeconds: number; endSeconds: number }`
  - `cueWindows(anchored: AnchoredCue[], alignment: Alignment): CueWindow[]`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/script-cues.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import type { Alignment } from "@/lib/captions";
import { anchorCues, cueWindows, extractAnchor } from "@/lib/script-cues";

/** Every character takes exactly 0.1s, mirroring captions.test.ts's fixture. */
function evenAlignment(text: string): Alignment {
  const characters = [...text];
  return {
    characters,
    characterStartTimesSeconds: characters.map((_, i) => i * 0.1),
    characterEndTimesSeconds: characters.map((_, i) => (i + 1) * 0.1),
  };
}

describe("extractAnchor", () => {
  it("takes the first eight words", () => {
    const anchor = extractAnchor("one two three four five six seven eight nine ten");
    expect(anchor).toBe("one two three four five six seven eight");
  });

  it("takes the whole section when it is shorter than eight words", () => {
    expect(extractAnchor("short section here")).toBe("short section here");
  });

  it("collapses runs of whitespace so a reflowed edit still matches", () => {
    expect(extractAnchor("one   two\nthree")).toBe("one two three");
  });
});

describe("anchorCues", () => {
  const content = "Inflation is not prices going up. It is money losing value over time.";

  it("locates each anchor and runs each section to the next", () => {
    const { anchored, orphaned } = anchorCues(
      [
        { anchor: "Inflation is not prices going up.", cue: "supermarket shelves" },
        { anchor: "It is money losing value over", cue: "printing press" },
      ],
      content,
    );

    expect(orphaned).toEqual([]);
    expect(anchored[0].cue).toBe("supermarket shelves");
    expect(anchored[0].startChar).toBe(0);
    // The first section ends where the second begins.
    expect(anchored[0].endChar).toBe(anchored[1].startChar);
    // The last section runs to the end of the content.
    expect(anchored[1].endChar).toBe(content.length);
  });

  it("orphans a cue whose opening was rewritten, keeping the others", () => {
    const { anchored, orphaned } = anchorCues(
      [
        { anchor: "Inflation is not prices going up.", cue: "supermarket shelves" },
        { anchor: "This sentence is not in the content", cue: "printing press" },
      ],
      content,
    );

    expect(anchored.map((a) => a.cue)).toEqual(["supermarket shelves"]);
    expect(orphaned.map((o) => o.cue)).toEqual(["printing press"]);
  });

  it("does not let a repeated phrase capture an earlier cue", () => {
    // "the same words" appears twice; the second cue must match the SECOND
    // occurrence, because its search starts after the first anchor ended.
    const repeated = "the same words appear here and then the same words appear again";
    const { anchored, orphaned } = anchorCues(
      [
        { anchor: "the same words", cue: "first" },
        { anchor: "the same words", cue: "second" },
      ],
      repeated,
    );

    expect(orphaned).toEqual([]);
    expect(anchored[0].startChar).toBe(0);
    expect(anchored[1].startChar).toBe(repeated.lastIndexOf("the same words"));
  });

  it("returns nothing to anchor when there are no cues", () => {
    expect(anchorCues([], content)).toEqual({ anchored: [], orphaned: [] });
  });
});

describe("cueWindows", () => {
  it("converts character ranges into the times those characters are spoken", () => {
    const content = "abcdefghij";
    const windows = cueWindows(
      [
        { cue: "first", startChar: 0, endChar: 5 },
        { cue: "second", startChar: 5, endChar: 10 },
      ],
      evenAlignment(content),
    );

    // 0.1s per character: chars 0-4 span 0.0s to 0.5s.
    expect(windows[0]).toEqual({ cue: "first", startSeconds: 0, endSeconds: 0.5 });
    expect(windows[1]).toEqual({ cue: "second", startSeconds: 0.5, endSeconds: 1 });
  });

  it("clamps a range that runs past the alignment rather than returning NaN", () => {
    // A shorter alignment than the content can happen if narration was
    // regenerated from an edited script; a clip of NaN length would kill FFmpeg.
    const windows = cueWindows(
      [{ cue: "only", startChar: 0, endChar: 100 }],
      evenAlignment("abcde"),
    );

    expect(windows[0].endSeconds).toBe(0.5);
    expect(Number.isFinite(windows[0].startSeconds)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/script-cues.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/script-cues"`

- [ ] **Step 3: Implement the module**

Create `src/lib/script-cues.ts`:

```typescript
import type { Alignment } from "@/lib/captions";

/** How many words of a section's opening identify it. Long enough to be
 *  unique in a script, short enough that editing inside a section keeps its
 *  cue — only rewriting the opening orphans it. */
const ANCHOR_WORDS = 8;

export interface ScriptCue {
  /** The first `ANCHOR_WORDS` words of this cue's section, verbatim. */
  anchor: string;
  /** What to show: a stock-footage search query. */
  cue: string;
}

export interface AnchoredCue {
  cue: string;
  /** Index into the narration content where this section starts. */
  startChar: number;
  /** Exclusive end — the next section's start, or the content's length. */
  endChar: number;
}

export interface CueWindow {
  cue: string;
  startSeconds: number;
  endSeconds: number;
}

/** Whitespace is collapsed so that a reflowed paragraph still matches: an
 *  editor that rewraps lines changes the bytes without changing the words. */
function normalise(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function extractAnchor(sectionText: string): string {
  return normalise(sectionText).split(" ").slice(0, ANCHOR_WORDS).join(" ");
}

/**
 * Locates each cue's section in the narration.
 *
 * The search is ordered — each one begins where the previous anchor ended —
 * so a phrase that recurs later in the script cannot capture an earlier cue.
 * A cue whose anchor is not found from that point on is orphaned rather than
 * matched loosely: a cue pointing at the wrong sentence is worse than one
 * that falls back to a topic-level clip.
 */
export function anchorCues(
  cues: ScriptCue[],
  content: string,
): { anchored: AnchoredCue[]; orphaned: ScriptCue[] } {
  const anchored: AnchoredCue[] = [];
  const orphaned: ScriptCue[] = [];
  let searchFrom = 0;

  for (const cue of cues) {
    const at = content.indexOf(cue.anchor, searchFrom);

    if (at === -1) {
      orphaned.push(cue);
      continue;
    }

    anchored.push({ cue: cue.cue, startChar: at, endChar: content.length });
    searchFrom = at + cue.anchor.length;
  }

  // Each section runs to the start of the next. Done in a second pass because
  // a section's end is only known once its successor has been located.
  for (let i = 0; i < anchored.length - 1; i++) {
    anchored[i].endChar = anchored[i + 1].startChar;
  }

  return { anchored, orphaned };
}

/**
 * Turns character ranges into the times those characters are spoken.
 *
 * This works because `voiceover.service.ts` sends `content.trim()` to
 * ElevenLabs verbatim, so alignment indices and content indices are the same
 * indices. Ranges are clamped to the alignment's length: a range past the end
 * would otherwise produce `undefined` and then a NaN clip duration, which
 * FFmpeg treats as an error rather than a no-op.
 */
export function cueWindows(
  anchored: AnchoredCue[],
  alignment: Alignment,
): CueWindow[] {
  const lastIndex = alignment.characters.length - 1;

  return anchored.map(({ cue, startChar, endChar }) => {
    const start = Math.min(Math.max(0, startChar), lastIndex);
    const end = Math.min(Math.max(0, endChar - 1), lastIndex);

    return {
      cue,
      startSeconds: alignment.characterStartTimesSeconds[start],
      endSeconds: alignment.characterEndTimesSeconds[end],
    };
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/script-cues.test.ts`
Expected: PASS — 10 tests

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/lib/script-cues.ts src/lib/script-cues.test.ts`
Expected: no output from either

- [ ] **Step 6: Commit**

```bash
git add src/lib/script-cues.ts src/lib/script-cues.test.ts
git commit -m "feat: anchor b-roll cues to narration and convert them to time ranges"
```

---

### Task 2: Store cues on the script

Adds the column and has the script model return sections. Narration text must
come out byte-identical to today.

**Files:**
- Modify: `prisma/schema.prisma` (`ScriptVersion`, around line 267)
- Modify: `src/services/providers/types.ts:11-19`
- Modify: `src/services/providers/gateway.provider.ts` (the `generateScript` method)
- Modify: `src/services/script.service.ts:102` (the `ScriptVersion` create)
- Test: `src/services/script.service.test.ts`

**Interfaces:**
- Consumes: `extractAnchor`, `ScriptCue` from Task 1
- Produces:
  - `ScriptSection = { text: string; cue: string }` in `providers/types.ts`
  - `ScriptGenerationResult.sections?: ScriptSection[]`
  - `ScriptVersion.cues` — `Json?`, holding `ScriptCue[]`

- [ ] **Step 1: Add the column**

In `prisma/schema.prisma`, inside `model ScriptVersion`, after `wordCount`:

```prisma
  /// Ordered b-roll cues, one per narration section, as ScriptCue[] (see
  /// src/lib/script-cues.ts). Nullable with no backfill: scripts written
  /// before this feature render exactly as they did, drawing entirely from
  /// the topic-level fallback pool.
  cues      Json?
```

- [ ] **Step 2: Create and apply the migration**

```bash
npx prisma migrate dev --name add_script_version_cues
```

Expected: a new folder under `prisma/migrations/` and a regenerated client.

- [ ] **Step 3: Write the failing test**

Append to `src/services/script.service.test.ts`, inside the existing top-level
`describe`:

```typescript
  it("stores one cue per section, anchored to that section's opening", async () => {
    const videoId = await createDraftVideo();

    const provider = stubProvider({
      content: "Inflation is not prices going up. It is money losing value.",
      sections: [
        { text: "Inflation is not prices going up.", cue: "supermarket shelves" },
        { text: "It is money losing value.", cue: "printing press running" },
      ],
    });

    await new ScriptService(provider).generate(userId, videoId);

    const version = await prisma.scriptVersion.findFirstOrThrow({
      where: { script: { videoId } },
      orderBy: { version: "desc" },
    });

    // Narration is unchanged in shape: the sections joined, nothing else.
    expect(version.content).toBe(
      "Inflation is not prices going up. It is money losing value.",
    );
    expect(version.cues).toEqual([
      { anchor: "Inflation is not prices going up.", cue: "supermarket shelves" },
      { anchor: "It is money losing value.", cue: "printing press running" },
    ]);
  });

  it("stores no cues when the model returns no sections", async () => {
    const videoId = await createDraftVideo();
    const provider = stubProvider({ content: "A script with no sections." });

    await new ScriptService(provider).generate(userId, videoId);

    const version = await prisma.scriptVersion.findFirstOrThrow({
      where: { script: { videoId } },
      orderBy: { version: "desc" },
    });

    // Nothing to anchor, and nothing that would break an existing pipeline.
    expect(version.cues).toBeNull();
  });
```

If `createDraftVideo` and `stubProvider` do not already exist in that file,
read the file's existing helpers and use whatever it already uses to build a
DRAFT video and an injected provider — this file already injects a provider,
following the same shape as `render.service.test.ts`'s spawner.

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run src/services/script.service.test.ts -t "stores one cue per section"`
Expected: FAIL — `version.cues` is `null`, not the expected array

- [ ] **Step 5: Extend the provider contract**

In `src/services/providers/types.ts`, add above `ScriptGenerationResult`:

```typescript
export interface ScriptSection {
  /** This section's narration, verbatim. Joined with the others to form the
   *  script's `content` — nothing here is metadata, it is all spoken. */
  text: string;
  /** A stock-footage search query for what to show while `text` is read. */
  cue: string;
}
```

and add to `ScriptGenerationResult`:

```typescript
  /** Absent when the model returned prose rather than sections — older
   *  prompts, or a provider that does not support structured output. The
   *  pipeline treats that as "no cues" rather than an error. */
  sections?: ScriptSection[];
```

- [ ] **Step 6: Return sections from the gateway provider**

In `src/services/providers/gateway.provider.ts`, replace the `generateText`
call inside `generateScript` with `generateObject`:

```typescript
import { generateObject } from "ai";
import { z } from "zod";

const scriptSchema = z.object({
  sections: z
    .array(
      z.object({
        text: z
          .string()
          .describe("This section's narration. Roughly 20-25 words."),
        cue: z
          .string()
          .describe(
            "A short stock-footage search query for what to show while this " +
              "is read. Describe the visual, not the idea: " +
              '"printing press running", not "monetary expansion".',
          ),
      }),
    )
    .min(1),
});

const result = await generateObject({
  model: gateway(modelId),
  schema: scriptSchema,
  prompt: input.prompt,
});

const sections = result.object.sections;
const content = sections.map((section) => section.text).join(" ");
```

Return `content` and `sections` alongside the existing token, cost and latency
fields, reading them from `result.usage` exactly as the `generateText` version
did.

- [ ] **Step 7: Store the cues**

In `src/services/script.service.ts`, import from Task 1:

```typescript
import { extractAnchor } from "@/lib/script-cues";
```

and in the `ScriptVersion` create at line 102, alongside `content`:

```typescript
            // Null rather than an empty array when the model returned prose:
            // the column's meaning is "this script has no cues", and an empty
            // array would read as "it has cues, and there are none".
            cues:
              generated.sections?.map((section) => ({
                anchor: extractAnchor(section.text),
                cue: section.cue,
              })) ?? undefined,
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/services/script.service.test.ts`
Expected: PASS — all tests in the file, including the two new ones

- [ ] **Step 9: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/services src/lib`
Expected: no output from either

- [ ] **Step 10: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/services/providers/types.ts src/services/providers/gateway.provider.ts src/services/script.service.ts src/services/script.service.test.ts
git commit -m "feat: have the script model emit a b-roll cue per section"
```

---

### Task 3: Keep cues attached across script edits

An edit at Gate 1 must re-locate cues rather than silently invalidate them.

**Files:**
- Modify: `src/services/script.service.ts:215` (`saveEdit`)
- Test: `src/services/script.service.test.ts`

**Interfaces:**
- Consumes: `anchorCues`, `ScriptCue` from Task 1; `ScriptVersion.cues` from Task 2
- Produces: `saveEdit` carries surviving cues onto the new version and returns
  `{ orphanedCueCount: number }`

- [ ] **Step 1: Write the failing tests**

Append to `src/services/script.service.test.ts`:

```typescript
  it("carries cues onto an edited version when their openings survive", async () => {
    const videoId = await createDraftVideo();
    const provider = stubProvider({
      content: "Inflation is not prices going up. It is money losing value.",
      sections: [
        { text: "Inflation is not prices going up.", cue: "supermarket shelves" },
        { text: "It is money losing value.", cue: "printing press running" },
      ],
    });
    const service = new ScriptService(provider);
    await service.generate(userId, videoId);

    // Edits the END of the second section; both openings are untouched.
    const result = await service.saveEdit(
      userId,
      videoId,
      "Inflation is not prices going up. It is money losing value every year.",
    );

    expect(result.orphanedCueCount).toBe(0);

    const version = await prisma.scriptVersion.findFirstOrThrow({
      where: { script: { videoId } },
      orderBy: { version: "desc" },
    });
    expect(version.cues).toHaveLength(2);
  });

  it("reports a cue whose opening was rewritten instead of dropping it silently", async () => {
    const videoId = await createDraftVideo();
    const provider = stubProvider({
      content: "Inflation is not prices going up. It is money losing value.",
      sections: [
        { text: "Inflation is not prices going up.", cue: "supermarket shelves" },
        { text: "It is money losing value.", cue: "printing press running" },
      ],
    });
    const service = new ScriptService(provider);
    await service.generate(userId, videoId);

    const result = await service.saveEdit(
      userId,
      videoId,
      "Inflation is not prices going up. Money buys less than it used to.",
    );

    // The second cue's anchor is gone; the first still stands.
    expect(result.orphanedCueCount).toBe(1);

    const version = await prisma.scriptVersion.findFirstOrThrow({
      where: { script: { videoId } },
      orderBy: { version: "desc" },
    });
    expect(version.cues).toHaveLength(1);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/services/script.service.test.ts -t "carries cues onto an edited version"`
Expected: FAIL — `result.orphanedCueCount` is `undefined`

- [ ] **Step 3: Re-anchor in saveEdit**

In `src/services/script.service.ts`, import:

```typescript
import { anchorCues, type ScriptCue } from "@/lib/script-cues";
```

In `saveEdit`, before creating the new `ScriptVersion`, read the current
version's cues and re-anchor them against the incoming content:

```typescript
    // Cues are re-located against the edited text rather than carried over
    // blindly. An anchor that no longer appears means the operator rewrote
    // that section's opening; its cue is dropped and reported, and that
    // stretch falls back to a topic-level clip at collection time.
    const previousCues = (currentVersion?.cues ?? []) as ScriptCue[];
    const { anchored, orphaned } = anchorCues(previousCues, content.trim());

    const survivingCues: ScriptCue[] = anchored.map((entry) => ({
      anchor: content.trim().slice(entry.startChar, entry.endChar).trim(),
      cue: entry.cue,
    }));
```

Store `survivingCues.length > 0 ? survivingCues : undefined` as `cues` on the
new version, and return `{ orphanedCueCount: orphaned.length }` alongside
whatever `saveEdit` already returns.

Note: `survivingCues[i].anchor` is re-derived from the *edited* content, so
subsequent edits anchor against what the operator can actually see. Re-run
`extractAnchor` on that slice to keep anchors eight words long:

```typescript
    const survivingCues: ScriptCue[] = anchored.map((entry) => ({
      anchor: extractAnchor(content.trim().slice(entry.startChar, entry.endChar)),
      cue: entry.cue,
    }));
```

Use this second form; the first is shown only to explain why the slice exists.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/services/script.service.test.ts`
Expected: PASS — all tests in the file

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/services/script.service.ts`
Expected: no output from either

- [ ] **Step 6: Commit**

```bash
git add src/services/script.service.ts src/services/script.service.test.ts
git commit -m "feat: re-anchor b-roll cues when the operator edits a script"
```

---

### Task 4: Collect one clip per cue

**Files:**
- Modify: `src/services/footage.service.ts` (`collect`, from line 147)
- Test: `src/services/footage.service.test.ts`

**Interfaces:**
- Consumes: `anchorCues`, `ScriptCue` from Task 1; `ScriptVersion.cues` from Task 2
- Produces: clips at `videos/{videoId}/clips/section-{NNN}.mp4`, zero-padded to
  three digits, one per anchored cue, in order

- [ ] **Step 1: Write the failing tests**

Append to `src/services/footage.service.test.ts`:

```typescript
  it("stores one clip per cue, named in play order", async () => {
    const videoId = await makeVideoWithCues([
      { anchor: "Inflation is not prices going", cue: "supermarket shelves" },
      { anchor: "It is money losing value", cue: "printing press" },
    ]);

    await footageService.collect(userId, videoId);

    const assets = await prisma.asset.findMany({
      where: { kind: "VIDEO", storagePath: { startsWith: `videos/${videoId}/` } },
      orderBy: { storagePath: "asc" },
    });

    expect(assets.map((a) => a.storagePath)).toEqual([
      `videos/${videoId}/clips/section-000.mp4`,
      `videos/${videoId}/clips/section-001.mp4`,
    ]);
  });

  it("never uses the same stock clip for two different cues", async () => {
    // Both cues' searches return the SAME clip first. The second must take
    // its next-best result rather than repeating the picture.
    const videoId = await makeVideoWithCues([
      { anchor: "first section opening words here", cue: "money" },
      { anchor: "second section opening words here", cue: "cash" },
    ]);

    await footageService.collect(userId, videoId);

    const assets = await prisma.asset.findMany({
      where: { kind: "VIDEO", storagePath: { startsWith: `videos/${videoId}/` } },
    });
    const externalIds = assets.map((a) => a.externalId);

    expect(new Set(externalIds).size).toBe(externalIds.length);
  });

  it("falls back to the topic pool for a cue that finds nothing", async () => {
    const videoId = await makeVideoWithCues([
      { anchor: "first section opening words here", cue: "__no_results__" },
    ]);

    await footageService.collect(userId, videoId);

    // A section with no match still gets a picture; a black screen is worse
    // than a loosely-related clip.
    const assets = await prisma.asset.findMany({
      where: { kind: "VIDEO", storagePath: { startsWith: `videos/${videoId}/` } },
    });
    expect(assets).toHaveLength(1);
  });

  it("searches Pixabay only when Pexels returns nothing for a cue", async () => {
    const { pexelsCalls, pixabayCalls } = trackProviderCalls();
    const videoId = await makeVideoWithCues([
      { anchor: "first section opening words here", cue: "money" },
    ]);

    await footageService.collect(userId, videoId);

    // Pexels allows 200 searches an hour; querying both per cue would
    // exhaust it in two videos.
    expect(pexelsCalls().length).toBeGreaterThan(0);
    expect(pixabayCalls()).toHaveLength(0);
  });
```

Build `makeVideoWithCues` and `trackProviderCalls` on the fixtures this file
already has — it already injects fake providers and creates videos with
narration. Read the existing helpers before writing new ones; do not duplicate
them.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/services/footage.service.test.ts -t "stores one clip per cue"`
Expected: FAIL — paths are `clips/clip-0.mp4`, not `clips/section-000.mp4`

- [ ] **Step 3: Implement per-cue collection**

In `src/services/footage.service.ts`, in `collect`:

1. Load the video's active `ScriptVersion.cues` and anchor them against
   `content` with `anchorCues`.
2. When there are no anchored cues, keep today's behaviour exactly: one
   topic-level search, `MAX_UNIQUE_CLIPS` clips, existing paths. This is what
   makes the nullable column safe for old scripts.
3. When there are anchored cues, run one Pexels search per cue. Track chosen
   `externalId`s in a `Set`; if a cue's best result is already taken, walk its
   results for the first unused one.
4. A cue with no usable result falls back to Pixabay for that cue only, then to
   a topic-level pool searched once up front.
5. Store each chosen clip at
   `videos/${videoId}/clips/section-${String(index).padStart(3, "0")}.mp4`.

Zero-padding to three digits makes play order lexicographic, so render can sort
by path instead of relying on `createdAt`, which is an accident of insertion
timing rather than a guarantee.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/services/footage.service.test.ts`
Expected: PASS — all tests, including the four new ones and the existing
"caps the number of unique clips" test, which still covers the no-cues path

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/services/footage.service.ts`
Expected: no output from either

- [ ] **Step 6: Commit**

```bash
git add src/services/footage.service.ts src/services/footage.service.test.ts
git commit -m "feat: collect one stock clip per b-roll cue"
```

---

### Task 5: Cut on the sentence, not the timer

Replaces fixed slots with per-section durations and deletes the looping.

**Files:**
- Modify: `src/lib/ffmpeg-command.ts` (`planRender`, `SegmentInput`)
- Modify: `src/services/render.service.ts` (`ensureCoverage`, `CLIP_SECONDS`, the render body)
- Test: `src/lib/ffmpeg-command.test.ts`, `src/services/render.service.test.ts`

**Interfaces:**
- Consumes: `cueWindows`, `anchorCues` from Task 1; section clip paths from Task 4
- Produces: `planRender(clipPaths: string[], segmentDir: string, durations: number[])`
  — one duration per clip path, in order

- [ ] **Step 1: Write the failing test**

Add to `src/lib/ffmpeg-command.test.ts`:

```typescript
describe("planRender with per-section durations", () => {
  it("gives each segment its own duration", () => {
    const plan = planRender(
      ["/tmp/a.mp4", "/tmp/b.mp4"],
      "/tmp",
      [7.5, 11.25],
    );

    expect(plan.segments.map((s) => s.clipSeconds)).toEqual([7.5, 11.25]);
  });

  it("refuses a duration list that does not match the clips", () => {
    // A mismatch means picture and narration would drift apart silently,
    // which is worse than refusing to render.
    expect(() => planRender(["/tmp/a.mp4"], "/tmp", [7.5, 11.25])).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/ffmpeg-command.test.ts -t "gives each segment its own duration"`
Expected: FAIL — `planRender` takes `clipSeconds: number`, not an array

- [ ] **Step 3: Change planRender's signature**

In `src/lib/ffmpeg-command.ts`, replace the `clipSeconds = DEFAULT_CLIP_SECONDS`
parameter with `durations: number[]`, throw a `ValidationError` when
`durations.length !== clipPaths.length`, and set each segment's `clipSeconds`
from `durations[i]`.

With one clip per section there are no repeats to dedupe, but leave the
dedupe in place: it costs nothing and a fallback pool can legitimately hand the
same clip to two sections.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/ffmpeg-command.test.ts`
Expected: PASS — all tests

- [ ] **Step 5: Write the failing render test**

Add to `src/services/render.service.test.ts`:

```typescript
  it("gives each section a segment as long as that section is spoken", async () => {
    const videoId = await makeRenderableVideoWithCues([
      { anchor: "first section opening words here", cue: "money" },
      { anchor: "second section opening words here", cue: "cash" },
    ]);

    const segmentDurations: string[] = [];
    const { spawner } = createSpawner(async (child, args) => {
      if (!args.includes("-progress")) {
        // A segment pass: capture its input-level -t.
        segmentDurations.push(args[args.indexOf("-t") + 1]);
      }
      await writeFile(args[args.length - 1], "fake-bytes");
      child.emit("close", 0);
    });

    await new RenderService(spawner).render(userId, videoId);

    // Two sections, two segments, and their lengths differ because the
    // sections take different times to say.
    expect(segmentDurations).toHaveLength(2);
    expect(new Set(segmentDurations).size).toBe(2);
  });
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run src/services/render.service.test.ts -t "gives each section a segment"`
Expected: FAIL — every segment carries the same `-t 12`

- [ ] **Step 7: Wire timing into render**

In `src/services/render.service.ts`:

1. Delete `ensureCoverage` and `CLIP_SECONDS` entirely.
2. Load the active script's `cues`, anchor them against `content`, and convert
   to windows with `cueWindows(anchored, alignment)` — the alignment is already
   read for captions.
3. Order clip assets by `storagePath` ascending, not `createdAt`.
4. Pass `windows.map((w) => w.endSeconds - w.startSeconds)` as `planRender`'s
   durations.
5. When a video has no cues, keep today's path: read clips as now, cap at
   `MAX_RENDER_CLIPS`, and give every segment an equal share of the narration's
   duration. This is what keeps pre-cue scripts rendering.
6. Throw a `ConflictError` when the anchored cue count and the clip count
   disagree. That can only come from a bug, and a video whose picture drifts
   out of sync is worse than one that refuses to render.

- [ ] **Step 8: Run the full render suite**

Run: `npx vitest run src/services/render.service.test.ts src/lib/ffmpeg-command.test.ts`
Expected: PASS — all tests in both files

- [ ] **Step 9: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/services/render.service.ts src/lib/ffmpeg-command.ts`
Expected: no output from either

- [ ] **Step 10: Commit**

```bash
git add src/lib/ffmpeg-command.ts src/lib/ffmpeg-command.test.ts src/services/render.service.ts src/services/render.service.test.ts
git commit -m "feat: cut footage on sentence boundaries instead of a fixed timer"
```

---

### Task 6: Show orphaned cues and reclaim storage

The two operator-facing loose ends: seeing when an edit broke a cue, and not
letting footage accumulate forever.

**Files:**
- Modify: `src/features/videos/components/script-panel.tsx`
- Modify: `src/services/publish.service.ts`
- Test: `src/services/publish.service.test.ts`

**Interfaces:**
- Consumes: `orphanedCueCount` from Task 3; section clip paths from Task 4

- [ ] **Step 1: Surface orphaned cues after an edit**

In `src/features/videos/components/script-panel.tsx`, where `saveEditAction`'s
result is handled, when `orphanedCueCount > 0` show a toast:

```typescript
      toast.warning(
        `${result.data.orphanedCueCount} section(s) lost their footage cue`,
        {
          description:
            "Those parts will use general footage for the topic instead. " +
            "Regenerate the script to get matched footage back.",
        },
      );
```

Thread `orphanedCueCount` through `saveEditAction`'s `ActionResult` payload.

- [ ] **Step 2: Write the failing retention test**

Add to `src/services/publish.service.test.ts`:

```typescript
  it("deletes the video's stock clips once it is published", async () => {
    const videoId = await makePublishableVideo();

    await publishService.publish(userId, videoId);

    // Source clips have done their job; ~400MB per video would make storage
    // the binding constraint at around 200 videos.
    const clips = await prisma.asset.findMany({
      where: {
        kind: "VIDEO",
        deletedAt: null,
        storagePath: { startsWith: `videos/${videoId}/clips/` },
      },
    });
    expect(clips).toHaveLength(0);
  });
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/services/publish.service.test.ts -t "deletes the video's stock clips"`
Expected: FAIL — the clips are still there

- [ ] **Step 4: Delete clips after a successful publish**

In `src/services/publish.service.ts`, after the publication row is committed,
soft-delete the video's clip assets and remove their stored objects.

Do this **after** the transaction, not inside it: a storage failure must not
roll back a publish that YouTube has already accepted. Wrap it so a failure is
logged and swallowed — leftover clips cost storage, a failed publish costs the
video.

Clips are kept through READY and FAILED so retries and re-renders work without
re-fetching; only PUBLISHED triggers this.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/services/publish.service.test.ts`
Expected: PASS — all tests

- [ ] **Step 6: Typecheck, lint and build**

Run: `npx tsc --noEmit && npx eslint src && pnpm build`
Expected: no errors; build compiles

- [ ] **Step 7: Commit**

```bash
git add src/features/videos/components/script-panel.tsx src/services/publish.service.ts src/services/publish.service.test.ts
git commit -m "feat: report orphaned cues and reclaim clip storage after publish"
```

---

## Verification

After Task 6, before considering this done:

- [ ] `pnpm typecheck && pnpm lint && pnpm build` all pass
- [ ] `npx vitest run src/lib/script-cues.test.ts src/lib/ffmpeg-command.test.ts` passes
- [ ] Service tests pass — run them **one file at a time**; they share a remote
      database and several take over 100 seconds, so a parallel run produces
      timeouts that look like failures but are contention
- [ ] A video whose script predates this change still renders end to end
- [ ] The operator's real ElevenLabs credential still exists:
      one active row, `keyLastFour` `3785`, label `Framecast`
