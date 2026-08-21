# Doodle Format Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Framecast a stick-figure doodle format — a new art style, a new footage style, and an operator-chosen cutting cadence — without touching the render path.

**Architecture:** The cadence is spent at *script* time, not render time. `planStoryBeats` already cuts one picture per cue when every cue carries a shot tag, so asking the writer for N tagged sections performs the pacing arithmetic without threading a cadence argument through the three services that must agree on the grouping. A new `ChannelBrand.beatSeconds` is read in exactly one place (`script.service.ts`) and converted into a system instruction beside the prompt, the same way `recurringCharacterInstruction` already works.

**Tech Stack:** Next.js App Router, TypeScript, Prisma/Postgres, Zod, Vitest, FFmpeg, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-08-21-doodle-format-design.md`

## Global Constraints

- **Never run `npx prettier`.** This repo has no prettier; npx would fetch one and silently reformat the whole codebase. ESLint is the only formatter — `npm run lint`.
- **Never run two vitest processes at once.** Run `npx vitest run <path>` and wait for it to finish before the next one.
- **Service tests need the DB tunnel.** `localhost:55432` is an SSH tunnel that must be opened by hand before running any `*.service.test.ts`. Pure `src/lib/*` tests do not need it.
- **The migration folder must be `20260905090000_add_doodle_format`.** Existing folders run ahead of the calendar (latest is `20260904090000_add_credits`); a folder dated today would file this migration into the middle of history and run in the wrong order.
- **Migrations are not applied by any deploy step.** They are run by hand.
- **Do not deploy to staging.** Dev only — this is an explicit instruction from the operator.
- Column names in SQL are camelCase (`"channel_brand"."beatSeconds"`); only table names are snake_cased via `@@map`.
- Doc comments in this repo explain *why*, not *what*. Match that register — every constant introduced below carries the reason for its value.

---

### Task 1: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma` (the `FootageStyle` enum, and the `ChannelBrand` model)
- Create: `prisma/migrations/20260905090000_add_doodle_format/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `FootageStyle.DOODLE` and `ChannelBrand.beatSeconds: number | null`, both imported from `@/generated/prisma/enums` and the Prisma client by every later task.

- [ ] **Step 1: Add the enum value to the Prisma schema**

In `prisma/schema.prisma`, inside `enum FootageStyle`, after the `MIXED` entry:

```prisma
  /// Generated stick-figure stills on paper, one per scripted section, cut
  /// every five to twenty seconds. Searches no stock provider, exactly as
  /// CINEMATIC does.
  ///
  /// What separates it from CINEMATIC is not where the pictures come from but
  /// how many there are. CINEMATIC and ILLUSTRATED both let `planStoryBeats`
  /// group sections into pictures held 15-25 seconds, a band measured on
  /// four-minute bedtime stories. This style's script tags every section, which
  /// puts `planStoryBeats` on its one-picture-per-cue path and makes the
  /// writer's section count the video's picture count — so the cadence is a
  /// property of the script, not of the renderer.
  ///
  /// Reads no character sheet. `needsCharacterSheet` is ILLUSTRATED alone and
  /// stays that way: a stick figure's consistency is the line weight, which is
  /// in the art style prompt already, so there is nothing to pre-generate and
  /// an operator can make their first doodle video without opening the
  /// branding screen.
  DOODLE
```

- [ ] **Step 2: Add the column to `ChannelBrand`**

In `prisma/schema.prisma`, in the `ChannelBrand` model, directly after the `artStyle String?` field:

```prisma
  /// How many seconds one picture holds the screen, for a `DOODLE` channel.
  ///
  /// Read in exactly one place — `script.service.ts`, where it becomes a
  /// section count in a system instruction — and deliberately not passed to
  /// `planStoryBeats`. That function is called from footage, render and
  /// shorts, and its own doc comment states the premise this column must not
  /// break: the grouping has to be "derivable from data both of them have,
  /// without a stored plan that could drift from the script". A cadence fetched
  /// in three places is three chances to disagree, and a disagreement here puts
  /// pictures under the wrong words without throwing.
  ///
  /// Bounded 5-20 at the boundary (`updateBrandingSchema`). Under five is a
  /// strobe; over twenty is what ILLUSTRATED already does, so a channel wanting
  /// that should pick ILLUSTRATED rather than a doodle style imitating one.
  ///
  /// Nullable with no default, for the reason `artStyle` above is: a default
  /// would pick a rhythm for a channel that never asked for one. Null on a
  /// DOODLE channel is refused at script generation with a message naming the
  /// setting.
  beatSeconds Int?
```

- [ ] **Step 3: Write the migration**

Create `prisma/migrations/20260905090000_add_doodle_format/migration.sql`:

```sql
-- A fifth footage style, and the first whose cadence is a property of its
-- script rather than of the renderer.
--
-- ILLUSTRATED and CINEMATIC both generate their pictures and both let
-- planStoryBeats group sections into stills held 15-25 seconds — a band
-- measured on four-minute bedtime stories and documented in lib/story-beats.ts.
-- The doodle genre cuts every five to twenty seconds instead, and the way it
-- gets there is not a new grouping rule. planStoryBeats already cuts one
-- picture per cue when every cue carries a shot tag; the doodle script format
-- tags every section, so the writer's section count IS the picture count. That
-- is why this migration adds a column that no rendering code reads.
--
-- beatSeconds is where the operator's choice is stored, and script.service.ts
-- is the only thing that ever reads it — it turns the number into a requested
-- section count in a system instruction, and from that point on the cadence
-- travels inside ScriptVersion.cues, which footage, render and shorts already
-- all read. Passing it to planStoryBeats instead would put three separate
-- fetches behind a function whose whole premise is that no stored plan can
-- drift from the script.
--
-- Adding a value rather than replacing one, exactly as CINEMATIC and MIXED
-- were added. Every existing brand row keeps what it has, LIVE_ACTION stays the
-- column default, beatSeconds is NULL everywhere and needs no backfill, and no
-- channel's output changes until an operator picks the new option. Postgres
-- permits ALTER TYPE ... ADD VALUE inside a transaction (PG 12+) as long as the
-- new value is not *used* in the same transaction; the ALTER TABLE below adds a
-- column and does not use it.
ALTER TYPE "FootageStyle" ADD VALUE 'DOODLE';

ALTER TABLE "channel_brand" ADD COLUMN "beatSeconds" INTEGER;
```

- [ ] **Step 4: Regenerate the Prisma client and typecheck**

Run: `npx prisma generate && npx tsc --noEmit`
Expected: client regenerates; `tsc` reports errors only in files later tasks will touch (exhaustive `Record<FootageStyle, …>` maps in `footage.service.ts` and `footage-styles.ts` now missing a `DOODLE` key). That is the expected failure — those maps are exhaustive by design, which is how a new style announces every place it must be classified.

- [ ] **Step 5: Apply the migration by hand**

Open the SSH tunnel to `localhost:55432` first, then run: `npx prisma migrate deploy`
Expected: `20260905090000_add_doodle_format` applied.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260905090000_add_doodle_format
git commit -m "feat: add the DOODLE footage style and ChannelBrand.beatSeconds"
```

---

### Task 2: The doodle art style

**Files:**
- Modify: `src/lib/art-styles.ts`
- Test: `src/lib/art-styles.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ArtStyleId` gains the `"doodle-marker"` member. `updateBrandingSchema`'s `z.enum(ART_STYLES.map((style) => style.id))` picks it up with no change.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/art-styles.test.ts`:

```ts
describe("doodle-marker", () => {
  const doodle = findArtStyle("doodle-marker");

  it("is in the catalogue", () => {
    expect(doodle).not.toBeNull();
  });

  // The captions are white with a 2px black outline and that string is pinned
  // by a test in ffmpeg-command.test.ts. White text on white paper is
  // unreadable, so the paper is what has to move — see the spec's Quality
  // section. If someone "tidies" this to plain white, the captions go with it.
  it("asks for off-white paper rather than white, so captions stay legible", () => {
    expect(doodle?.prompt).toMatch(/off-white/i);
    expect(doodle?.prompt).not.toMatch(/\bpure white\b/i);
  });

  // A 1536x1024 still is covered into 1920x1080, so the top and bottom ~15% is
  // cropped away — and vertical Shorts keep only the centre 9:16.
  it("keeps the subject centred, because the frame crops top and bottom", () => {
    expect(doodle?.prompt).toMatch(/centred/i);
  });

  it("names no artist, studio or film", () => {
    for (const style of ART_STYLES) {
      expect(style.prompt).not.toMatch(/in the style of/i);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/art-styles.test.ts`
Expected: FAIL — `findArtStyle("doodle-marker")` returns null.

- [ ] **Step 3: Add the catalogue entry**

In `src/lib/art-styles.ts`, add `| "doodle-marker"` to the `ArtStyleId` union, and append to `ART_STYLES`:

```ts
  {
    id: "doodle-marker",
    name: "Marker doodle",
    description:
      "Thick black felt-tip stick figures on off-white paper, with two flat accent colours. The most stable look here — there is almost nothing in a stick figure to drift — and the clearest on a phone at speed, but it cannot carry mood or place.",
    prompt:
      "Hand-drawn marker doodle on paper. Stick figures with round solid-black " +
      "heads and simple straight-line limbs, drawn in a single thick black " +
      "felt-tip line of even weight; no shading, no gradients, no rendered " +
      "form. Warm off-white paper with faint grain. Two accent colours only — " +
      "a flat red and a flat blue — used sparingly as fills and repeated " +
      "exactly; everything else is black line on paper. Flat even light, no " +
      "shadows. Subject centred with generous empty margin above and below.",
  },
```

Add a paragraph to the file's header comment, under the existing "Every entry has to hold a character" section:

```
 * The seventh entry arrived from the other end of that bar rather than scraping
 * past it. The six above each pin *something* down — a flat shape, a solid
 * form, a piece of paper, an opaque patch of paint — because the styles that
 * were rejected are the ones whose appeal is looseness. A stick figure has
 * almost nothing in it to drift at all: two dots, a line, four limbs. It is the
 * easiest entry here to hold a character in, and the hardest to do anything
 * else with, which is why its description says so.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/art-styles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/art-styles.ts src/lib/art-styles.test.ts
git commit -m "feat: add the marker doodle art style"
```

---

### Task 3: The footage style option and its plan arm

**Files:**
- Modify: `src/lib/footage-styles.ts`
- Modify: `src/services/footage.service.ts` (`FOOTAGE_SEARCH_PLAN`, `GENERATED_STYLE_NOUN`, `collectGenerated`'s `kind` union and its call site)
- Test: `src/lib/footage-styles.test.ts`, `src/lib/recurring-character.test.ts`

**Interfaces:**
- Consumes: `FootageStyle.DOODLE` from Task 1.
- Produces: `FOOTAGE_SEARCH_PLAN.DOODLE === { kind: "DOODLE" }`; `collectGenerated`'s `kind` accepts `"DOODLE"`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/footage-styles.test.ts`:

```ts
describe("DOODLE", () => {
  it("is offered in the picker", () => {
    expect(FOOTAGE_STYLES.map((option) => option.value)).toContain("DOODLE");
  });

  // The whole point of the style: an operator can make their first doodle
  // video without generating anything on the branding screen first.
  it("needs no character sheet", () => {
    expect(needsCharacterSheet("DOODLE")).toBe(false);
  });
});
```

Append to `src/lib/recurring-character.test.ts`:

```ts
it("says nothing for a DOODLE channel, however good the brief is", () => {
  expect(
    recurringCharacterInstruction({ footageStyle: "DOODLE", characterBrief: PIP }),
  ).toBeNull();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/footage-styles.test.ts src/lib/recurring-character.test.ts`
Expected: the `FOOTAGE_STYLES` test FAILS (no `DOODLE` option). The two `needsCharacterSheet`/`recurringCharacterInstruction` tests should already PASS — `needsCharacterSheet` is `ILLUSTRATED` alone, so `DOODLE` is excluded automatically. That is deliberate: they are regression pins, not new behaviour. If either fails, someone has widened that classifier and the spec's §2 no longer holds.

- [ ] **Step 3: Add the picker option**

In `src/lib/footage-styles.ts`, append to `FOOTAGE_STYLES`:

```ts
  {
    value: "DOODLE",
    label: "Marker doodle",
    description:
      "Generated stick figures on paper, one per scripted section, cut every five to twenty seconds. Needs no character sheet — the line weight is the consistency — so a channel can make its first video without generating anything here first. Pick the seconds per picture below; it is the whole feel of the format.",
  },
```

- [ ] **Step 4: Add the plan arm and the noun**

In `src/services/footage.service.ts`:

Add to the `FootagePlan` union, beside `{ readonly kind: "MIXED" }`:

```ts
  /**
   * Generate every picture as a stick-figure still, and search nowhere.
   *
   * Identical to `CINEMATIC` in where the pictures come from, and different in
   * how many there are — which is not decided here. A doodle script tags every
   * section, so `planStoryBeats` returns one beat per cue and this arm simply
   * generates however many that is. The cadence lives in the script; see
   * `beatSeconds` on `ChannelBrand`.
   */
  | { readonly kind: "DOODLE" };
```

Add to `FOOTAGE_SEARCH_PLAN`:

```ts
  DOODLE: { kind: "DOODLE" },
```

Widen `GENERATED_STYLE_NOUN`'s key type to include `"DOODLE"` and add:

```ts
  DOODLE: "Doodle",
```

Widen `collectGenerated`'s `kind` parameter type from
`kind: "ILLUSTRATED" | "CINEMATIC" | "MIXED";` to
`kind: "ILLUSTRATED" | "CINEMATIC" | "MIXED" | "DOODLE";`

and widen the dispatch condition in `collect` from

```ts
    if (plan.kind === "ILLUSTRATED" || plan.kind === "CINEMATIC" || plan.kind === "MIXED") {
```

to

```ts
    if (
      plan.kind === "ILLUSTRATED" ||
      plan.kind === "CINEMATIC" ||
      plan.kind === "MIXED" ||
      plan.kind === "DOODLE"
    ) {
```

Inside `collectGenerated`, wherever `kind === "CINEMATIC"` is used to decide *not* to read `characterBrief`/`characterSheetPath`, `DOODLE` must take the same branch. Read the surrounding code and follow whichever shape it already uses (a `needsCharacterSheet(...)` call is preferred over a `kind ===` comparison, since that helper is documented as the single classifier).

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run src/lib/footage-styles.test.ts src/lib/recurring-character.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: no errors. Any remaining exhaustiveness error names a `Record<FootageStyle, …>` that still has no `DOODLE` key — fix it there rather than casting.

- [ ] **Step 6: Commit**

```bash
git add src/lib/footage-styles.ts src/lib/footage-styles.test.ts src/lib/recurring-character.test.ts src/services/footage.service.ts
git commit -m "feat: route DOODLE through the generated-footage path"
```

---

### Task 4: The cadence library

**Files:**
- Create: `src/lib/doodle-cadence.ts`
- Test: `src/lib/doodle-cadence.test.ts`

**Interfaces:**
- Consumes: `ScriptCue` from `@/lib/script-cues`.
- Produces, all imported by Task 5 and Task 8:
  - `DOODLE_MAX_SECONDS: 300`
  - `DOODLE_BEAT_MIN_SECONDS: 5`
  - `DOODLE_BEAT_MAX_SECONDS: 20`
  - `doodleSectionCount(targetSeconds: number, beatSeconds: number): number`
  - `doodleCadenceInstruction(sectionCount: number): string`
  - `countUntaggedCues(cues: readonly ScriptCue[]): number`

- [ ] **Step 1: Write the failing test**

Create `src/lib/doodle-cadence.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  countUntaggedCues,
  DOODLE_BEAT_MAX_SECONDS,
  DOODLE_BEAT_MIN_SECONDS,
  DOODLE_MAX_SECONDS,
  doodleCadenceInstruction,
  doodleSectionCount,
} from "@/lib/doodle-cadence";
import type { ScriptCue } from "@/lib/script-cues";

const cue = (shot?: "still" | "motion"): ScriptCue => ({
  anchor: "a b c d e f g h",
  cue: "a stick figure at a desk",
  ...(shot ? { shot } : {}),
});

describe("doodleSectionCount", () => {
  it("is the duration divided by the cadence", () => {
    expect(doodleSectionCount(300, 7)).toBe(43);
    expect(doodleSectionCount(300, 20)).toBe(15);
    expect(doodleSectionCount(300, 5)).toBe(60);
  });

  // The worst case the boundary allows, and the number the spec's cost table
  // is built on: 60 pictures is about $3.00.
  it("never exceeds the count the fastest allowed cadence gives", () => {
    const worst = doodleSectionCount(DOODLE_MAX_SECONDS, DOODLE_BEAT_MIN_SECONDS);
    expect(worst).toBe(60);
    expect(doodleSectionCount(DOODLE_MAX_SECONDS, DOODLE_BEAT_MAX_SECONDS)).toBeLessThan(worst);
  });

  // A one-section video is still a video; a zero-section video is a request
  // for a script with nothing in it.
  it("never returns less than one", () => {
    expect(doodleSectionCount(1, 20)).toBe(1);
    expect(doodleSectionCount(0, 20)).toBe(1);
  });
});

describe("doodleCadenceInstruction", () => {
  it("states the count and the tagging rule", () => {
    const instruction = doodleCadenceInstruction(43);
    expect(instruction).toContain("43");
    expect(instruction).toContain("[still]");
  });

  // The failure this whole warning path exists for: one missing tag drops the
  // video from 43 pictures to 15. The model has to be told what it costs.
  it("says what a missing tag costs", () => {
    expect(doodleCadenceInstruction(43)).toMatch(/every section/i);
  });
});

describe("countUntaggedCues", () => {
  it("is zero when every cue carries a tag", () => {
    expect(countUntaggedCues([cue("still"), cue("still")])).toBe(0);
  });

  it("counts the ones that do not", () => {
    expect(countUntaggedCues([cue("still"), cue(), cue("still"), cue()])).toBe(2);
  });

  // An empty script is not a partly tagged one. planStoryBeats' isShotScripted
  // returns false for an empty array too, but for a different reason, and
  // reporting "0 of 0 sections untagged" as a warning would be noise.
  it("is zero for an empty script", () => {
    expect(countUntaggedCues([])).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/doodle-cadence.test.ts`
Expected: FAIL — cannot resolve `@/lib/doodle-cadence`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/doodle-cadence.ts`:

```ts
import type { ScriptCue } from "@/lib/script-cues";

/**
 * The cadence arithmetic for the doodle format, and the reason it is arithmetic
 * on a section count rather than a rule in the renderer.
 *
 * `planStoryBeats` has two plans. The one it uses by default groups sections
 * into pictures held 15-25 seconds, from a constant measured on four-minute
 * bedtime stories. The other — taken when every cue carries a shot tag — cuts
 * one picture per cue, applies neither `BEAT_MIN_SECONDS` nor `MAX_BEATS`, and
 * is already how the long-form list format gets forty pictures out of eight
 * minutes. Its doc comment puts the whole design of this module in one line:
 * "Nothing here asks for that arithmetic; asking for forty sections is what
 * performs it."
 *
 * So a doodle channel's seconds-per-picture is converted into a *requested
 * section count* here, handed to the writer as a system instruction, and never
 * seen again. `footage.service.ts`, `render.service.ts` and `shorts.service.ts`
 * do not import this file and must not: they reach the same grouping from
 * `ScriptVersion.cues`, which all three already read, and that is what keeps
 * them from drifting apart.
 *
 * Pure, and client-safe on purpose — the branding screen shows the operator how
 * many pictures their setting implies before they save it.
 */

/**
 * The longest a doodle video may be.
 *
 * A money ceiling wearing a length's clothes. `MAX_BEATS` cannot serve here:
 * `planStoryBeats` deliberately does not apply it on the tagged path, because
 * "the writer's count is the count, it arrived with the script, and capping it
 * would drop shot forty-one silently". Capping the *duration* instead bounds
 * the spend without ever leaving narration with no picture over it.
 *
 * Five minutes at the fastest allowed cadence is sixty pictures, about $3.00 —
 * the same order as the ~$2.00 `MAX_BEATS` allows an illustrated video, and at
 * the expected seven seconds it is forty-three pictures and about $2.15.
 */
export const DOODLE_MAX_SECONDS = 300;

/**
 * The fastest a picture may be cut.
 *
 * Under five seconds stops being a video with a rhythm and becomes a strobe,
 * and it is also where the cost stops being defensible: the ceiling above is
 * computed against this number.
 */
export const DOODLE_BEAT_MIN_SECONDS = 5;

/**
 * The slowest a picture may be cut.
 *
 * Not a safety limit but a signpost. Twenty seconds is exactly what
 * `BEAT_TARGET_SECONDS` already gives an `ILLUSTRATED` channel, so a doodle
 * channel asking for more is asking for a style it could have picked directly —
 * and would be paying the tagged path's lack of a `MAX_BEATS` ceiling for the
 * privilege.
 */
export const DOODLE_BEAT_MAX_SECONDS = 20;

/**
 * How many sections the writer is asked for.
 *
 * Floored at one because a zero-section script is not a cheaper video, it is a
 * request for an empty one — the same reasoning `beatCountFor` gives for its
 * own floor.
 */
export function doodleSectionCount(targetSeconds: number, beatSeconds: number): number {
  return Math.max(1, Math.round(Math.max(0, targetSeconds) / beatSeconds));
}

/**
 * What the writer is told, as a system instruction.
 *
 * Sent *beside* the operator's prompt and never inside it, for the reasons
 * `script.service.ts` gives where it does the same thing for the recurring
 * character: `renderTemplate` treats a template's declared variables as
 * authoritative and leaves an undeclared `{{placeholder}}` unsubstituted so a
 * typo stays visible, so a token injected here would print verbatim in every
 * template that does not declare it — and appending prose to the template
 * instead would silently edit the operator's own template and then store the
 * edited text in `ScriptVersion.prompt`, whose whole job is to record what the
 * template said.
 *
 * The paragraph about a missing tag is not padding. One untagged section out of
 * forty-three drops `isShotScripted` to false and the video renders fifteen
 * pictures instead of forty-three — a finished-looking video that is quietly
 * the wrong film. `longform-list` warns about the same thing in its own prompt
 * for the same reason.
 */
export function doodleCadenceInstruction(sectionCount: number): string {
  return [
    "This channel draws every picture, one per section, so the number of " +
      "sections you write is the number of pictures the video has.",
    `Write exactly ${sectionCount} sections. Keep them short and even — this ` +
      "format cuts fast, and a section three times longer than its neighbours " +
      "holds one picture on screen while the rest flick past.",
    "Tag every section by putting [still] at the end of its cue. Every " +
      "section, without exception: one picture per section only happens when " +
      "every single one is tagged, and a single missing tag silently drops the " +
      "video to one picture every twenty seconds.",
  ].join("\n\n");
}

/**
 * How many cues came back without a shot tag.
 *
 * The detector for the one silent failure this format introduces. Zero for an
 * empty script rather than "all of them": `planStoryBeats` also declines the
 * tagged path for an empty script, but for an unrelated reason, and reporting
 * "0 of 0 sections untagged" would be noise on a script that has other problems.
 */
export function countUntaggedCues(cues: readonly ScriptCue[]): number {
  return cues.filter((cue) => !cue.shot).length;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/doodle-cadence.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/doodle-cadence.ts src/lib/doodle-cadence.test.ts
git commit -m "feat: add the doodle cadence arithmetic and its cue-tag detector"
```

---

### Task 5: `beatSeconds` through the boundary

**Files:**
- Modify: `src/schemas/channel.schema.ts` (`updateBrandingSchema`)
- Modify: `src/services/brand.service.ts` (the `ResolvedBranding`/`getBranding` shape at ~line 127 and ~line 312, the `select` at ~line 334, the mapping at ~line 373, and `updateBranding` at ~line 593)
- Test: `src/schemas/channel.schema.test.ts` (create if absent), `src/services/brand.service.test.ts`

**Interfaces:**
- Consumes: `DOODLE_BEAT_MIN_SECONDS`, `DOODLE_BEAT_MAX_SECONDS` from Task 4; `ChannelBrand.beatSeconds` from Task 1.
- Produces: `UpdateBrandingInput.beatSeconds: number | null`, and `beatSeconds: number | null` on whatever `brandService.getBranding` returns.

- [ ] **Step 1: Write the failing test**

Append to `src/schemas/channel.schema.test.ts` (create the file with the same imports the sibling schema tests use if it does not exist):

```ts
describe("updateBrandingSchema — beatSeconds", () => {
  const base = {
    channelId: "00000000-0000-0000-0000-000000000000",
    footageStyle: "DOODLE" as const,
    artStyle: "doodle-marker" as const,
  };

  it("accepts the ends of the allowed band", () => {
    expect(updateBrandingSchema.partial().parse({ ...base, beatSeconds: 5 }).beatSeconds).toBe(5);
    expect(updateBrandingSchema.partial().parse({ ...base, beatSeconds: 20 }).beatSeconds).toBe(20);
  });

  // Under five is a strobe; over twenty is ILLUSTRATED with extra steps and
  // without its MAX_BEATS ceiling.
  it("refuses outside it", () => {
    expect(() => updateBrandingSchema.partial().parse({ ...base, beatSeconds: 4 })).toThrow();
    expect(() => updateBrandingSchema.partial().parse({ ...base, beatSeconds: 21 })).toThrow();
  });

  it("refuses a fractional cadence", () => {
    expect(() => updateBrandingSchema.partial().parse({ ...base, beatSeconds: 7.5 })).toThrow();
  });

  // Same round-trip artStyle has: the picker's empty option and an untouched
  // field must mean one thing, and "nobody has chosen" is a real state.
  it("coerces an empty string to null", () => {
    expect(updateBrandingSchema.partial().parse({ ...base, beatSeconds: "" }).beatSeconds).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/schemas/channel.schema.test.ts`
Expected: FAIL — `beatSeconds` is stripped by `z.object`, so the accept cases return `undefined` and the refuse cases do not throw.

- [ ] **Step 3: Add the field to the schema**

In `src/schemas/channel.schema.ts`, import the bounds:

```ts
import { DOODLE_BEAT_MAX_SECONDS, DOODLE_BEAT_MIN_SECONDS } from "@/lib/doodle-cadence";
```

and add to `updateBrandingSchema`, after `artStyle`:

```ts
  /**
   * How long one picture holds the screen, for a `DOODLE` channel.
   *
   * Bounded here rather than in the service because the bounds are the
   * format's, not the database's: under `DOODLE_BEAT_MIN_SECONDS` is a strobe
   * and over `DOODLE_BEAT_MAX_SECONDS` is what `ILLUSTRATED` already does. An
   * integer because a fractional cadence would imply a precision the format
   * does not have — the writer is asked for a section count and the real
   * seconds fall out of how long the narration turns out to be.
   *
   * Nullable and round-tripping, exactly as `artStyle` above: "nobody has
   * chosen" is a real state, and it is what makes the doodle path refuse at
   * script generation rather than silently pick a rhythm.
   */
  beatSeconds: z
    .union([
      z.coerce
        .number()
        .int()
        .min(DOODLE_BEAT_MIN_SECONDS)
        .max(DOODLE_BEAT_MAX_SECONDS),
      z.literal(""),
      z.null(),
    ])
    .transform((value) => (value === "" || value === undefined ? null : value)),
```

- [ ] **Step 4: Thread it through `brand.service.ts`**

Four edits, mirroring exactly what `artStyle` does at each site:

1. Add `beatSeconds: number | null;` to the branding interface at ~line 127 and the row shape at ~line 312.
2. Add `beatSeconds: true,` to the `select` at ~line 334.
3. Add `beatSeconds: brand?.beatSeconds ?? null,` to the mapping at ~line 373.
4. In `updateBranding` (~line 593), write `beatSeconds` alongside `artStyle` in the `data` object.

Do **not** add it to `videoStyleSchema` — `beatSeconds` is a column, not part of the `videoStyle` JSON blob.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/schemas/channel.schema.test.ts`
Expected: PASS.

With the DB tunnel open, run: `npx vitest run src/services/brand.service.test.ts`
Expected: PASS — existing tests unaffected because the column is nullable with no default.

- [ ] **Step 6: Commit**

```bash
git add src/schemas/channel.schema.ts src/schemas/channel.schema.test.ts src/services/brand.service.ts
git commit -m "feat: accept and store a doodle channel's seconds per picture"
```

---

### Task 6: Motion off for doodle, under the operator's own setting

**Files:**
- Modify: `src/services/brand.service.ts` (`mergeVideoStyle` at line 384, and its call site at line 455)
- Test: `src/services/brand.service.test.ts`

**Interfaces:**
- Consumes: `FootageStyle` from Task 1.
- Produces: `mergeVideoStyle(stored: unknown, channelId: string | null, footageStyle: FootageStyle | null): VideoStyle` — note the **third parameter**, which the call site at line 455 must now pass.

- [ ] **Step 1: Write the failing test**

Append to `src/services/brand.service.test.ts`:

```ts
describe("mergeVideoStyle — the format's own default", () => {
  // The measurement this exists for is in ffmpeg-command.ts:189 — at scale
  // 1.15 the crop window travels 0.48px a frame and the picture is frozen for
  // 75.7% of adjacent frame pairs. On a photograph that judder hides; on a
  // thick black line against pale paper it is exactly where the eye is.
  it("turns motion off for a DOODLE channel that has not said otherwise", () => {
    expect(mergeVideoStyle(null, null, "DOODLE").motion.enabled).toBe(false);
  });

  it("leaves every other style panning as it always did", () => {
    expect(mergeVideoStyle(null, null, "ILLUSTRATED").motion.enabled).toBe(true);
    expect(mergeVideoStyle(null, null, null).motion.enabled).toBe(true);
  });

  // The layering that matters. The format supplies a better starting point
  // than DEFAULT_STYLE; it does not overrule a human being.
  it("loses to an operator who explicitly asked for motion", () => {
    const stored = { ...DEFAULT_STYLE, motion: { enabled: true, scale: 1.15 } };

    expect(mergeVideoStyle(stored, null, "DOODLE").motion.enabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

With the DB tunnel open, run: `npx vitest run src/services/brand.service.test.ts`
Expected: FAIL — `mergeVideoStyle` takes two arguments; TypeScript rejects the third.

- [ ] **Step 3: Add the layer**

In `src/services/brand.service.ts`, above `mergeVideoStyle`:

```ts
/**
 * What a footage style wants before the operator has said anything.
 *
 * A layer between `DEFAULT_STYLE` and the stored style, and the order is the
 * whole design: a format supplies a better starting point than the global
 * default, and an operator who has explicitly set the same field still wins.
 *
 * `DOODLE` turns the pan off. `ffmpeg-command.ts:189` records the measurement —
 * at `scale: 1.15` the crop window travels 0.48px a frame, `x` quantises to an
 * integer, and the picture is frozen for 75.7% of adjacent frame pairs. That
 * judder is invisible on a photograph and unmissable on a thick black line
 * against pale paper, where it reads as a broken encode. `kenburns` would be
 * smooth but pre-upscales the source 4x, forty-odd times a video, for a move
 * this genre does not use: the reference channels cut hard on static frames.
 *
 * Here rather than in `render.service.ts`, and that placement is the point.
 * `shorts.service.ts` re-composes through the same `composer.ts` and would need
 * the identical override, which is two places to disagree about what a doodle
 * video looks like. Both of them read their style from `resolve`.
 */
const FORMAT_STYLE_DEFAULTS: Partial<Record<FootageStyle, Partial<VideoStyle>>> = {
  DOODLE: { motion: { enabled: false, scale: DEFAULT_STYLE.motion.scale } },
};
```

Change the signature and the base it merges over:

```ts
function mergeVideoStyle(
  stored: unknown,
  channelId: string | null,
  footageStyle: FootageStyle | null,
): VideoStyle {
```

Inside, build the base by merging `FORMAT_STYLE_DEFAULTS[footageStyle]` (when `footageStyle` is non-null and has an entry) over `DEFAULT_STYLE`, and merge the parsed `stored` style over *that* instead of over `DEFAULT_STYLE` directly. Keep the existing "absent is not malformed" logging behaviour exactly as it is — a channel with no stored style must still not log.

At line 455, pass the style through:

```ts
      videoStyle: mergeVideoStyle(brand?.videoStyle, channelId, brand?.footageStyle ?? null),
```

- [ ] **Step 4: Run the test**

With the DB tunnel open, run: `npx vitest run src/services/brand.service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/brand.service.ts src/services/brand.service.test.ts
git commit -m "feat: cut doodle videos on static frames rather than panning them"
```

---

### Task 7: The `doodle-story` script style

**Files:**
- Modify: `src/lib/script-styles.ts`
- Test: `src/lib/script-styles.test.ts`

**Interfaces:**
- Consumes: `DOODLE_MAX_SECONDS` from Task 4.
- Produces: a `SCRIPT_STYLES` entry with `id: "doodle-story"` and `targetSeconds: 300`, resolvable via `findScriptStyle("doodle-story")`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/script-styles.test.ts`:

```ts
describe("doodle-story", () => {
  const style = findScriptStyle("doodle-story");

  it("is in the catalogue", () => {
    expect(style).not.toBeNull();
  });

  // The cap is a money ceiling wearing a length's clothes — see
  // DOODLE_MAX_SECONDS. A template that defaults past it would put every
  // operator straight into the refusal.
  it("does not default past the doodle length cap", () => {
    expect(style?.targetSeconds).toBeLessThanOrEqual(DOODLE_MAX_SECONDS);
  });

  // The section count is NOT in the template: it is computed from the
  // channel's beatSeconds and sent as a system instruction, because
  // renderTemplate leaves undeclared placeholders unsubstituted on purpose.
  it("does not hardcode a section count", () => {
    expect(style?.content).not.toMatch(/\b\d{2} sections\b/);
  });

  it("tells the writer to tag every section still", () => {
    expect(style?.content).toContain("[still]");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/script-styles.test.ts`
Expected: FAIL — `findScriptStyle("doodle-story")` returns null.

- [ ] **Step 3: Add the style**

In `src/lib/script-styles.ts`, append to `SCRIPT_STYLES`, following the shape of `longform-list` exactly (`id`, `name`, `description`, `category`, `targetLength`, `targetSeconds`, `content`, `variables`, `starterSubjects`):

```ts
  {
    id: "doodle-story",
    name: "Doodle story",
    description:
      "One person's story told in short lines over stick-figure drawings, cut fast. Suits a story with a turn in it — a mistake, a discovery, a decision that went badly and then well.",
    category: "SCRIPT",
    // A sibling of `longform-list`, and it differs in the same two ways that
    // one differs from `countdown`: it is shorter, and it decides its own
    // pictures. What it does NOT carry is a section count, which is the whole
    // reason it exists as its own style. `longform-list` writes "about 40
    // sections" into the prompt because eight minutes at twelve seconds is a
    // constant. A doodle channel's cadence is an operator setting, so the count
    // is computed per generation from `ChannelBrand.beatSeconds` and arrives as
    // a system instruction beside this template — see `doodleCadenceInstruction`
    // and script.service.ts's note on why it cannot be a {{variable}}.
    //
    // Every section is [still]. There is no [motion] arm: a stock clip dropped
    // between two stick figures is the one substitution this format must never
    // make, and unlike MIXED there is no judgement here for the writer to
    // record — it is always the same answer.
    targetLength: "About 5 minutes",
    targetSeconds: 300,
    content: [
      "Write a {{duration}}-minute narration script telling one story: {{topic}}",
      "",
      "Audience: {{audience}}",
      "Tone: {{tone}}",
      "",
      "LENGTH.",
      "The narration is read aloud at about 150 words a minute, so a {{duration}}-minute video needs roughly {{duration}} times 150 words. You will be told separately how many sections to write; divide the words evenly between them.",
      "",
      "STRUCTURE.",
      "- Open in the middle of a moment, not at the beginning of the story. A specific hour, a specific room, one thing going wrong.",
      "- Say who this is about in the first three sections, and never name them. 'You' or 'he' or 'she' — this format draws stick figures, and a stick figure with a name is a promise the picture cannot keep.",
      "- One idea per section. This video cuts every few seconds, so a section carrying two ideas gets one picture for both.",
      "- Put the turn about two thirds through: the moment the story stops going one way and goes the other. Everything before it is setup and everything after it is consequence.",
      "- Close on the smallest concrete detail, not on a lesson. The viewer draws the lesson; you draw the detail.",
      "",
      "SHOTS — this format decides its own pictures.",
      "- Tag every single section by putting [still] at the end of its cue: 'a figure alone at a desk, screen glowing [still]'. The tag is removed before anything is drawn.",
      "- Every section, without exception. One picture per section only happens when every section is tagged, and a single missing tag drops the whole video to one picture every twenty seconds.",
      "- Never tag anything [motion]. This channel draws everything; there is no stock footage in it.",
      "",
      VOICE_RULES,
      "",
      CUE_RULES,
      "- Cue what a stick figure can actually show: a posture, a gesture, one object, two figures and the distance between them. A cue that needs a face to work will not survive being drawn.",
      "- One or two figures a picture. A crowd of stick figures is a smudge.",
      "- The subject sits in the middle of the frame with room above and below it. The frame crops top and bottom, and vertical Shorts keep only the centre strip.",
    ].join("\n"),
    variables: [
      TOPIC,
      { key: "duration", label: "Duration (minutes)", defaultValue: "5" },
      { key: "audience", label: "Audience", defaultValue: "curious general viewers" },
      { key: "tone", label: "Tone", defaultValue: "plain and unhurried" },
    ],
    starterSubjects: [
      "The email that was sent to the wrong person, and what it fixed",
      "The habit that took four failed attempts before it held",
      "The job interview that went badly and led somewhere better",
      "The thing you bought to solve a problem you did not have",
      "The friendship that ended over something neither of them remembers",
    ],
  },
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/lib/script-styles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/script-styles.ts src/lib/script-styles.test.ts
git commit -m "feat: add the doodle story script format"
```

---

### Task 8: Wire the cadence into script generation

**Files:**
- Modify: `src/services/script.service.ts` (the `generate` method: the `system` assembly at ~line 213, and the activity message at ~line 415)
- Test: `src/services/script.service.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4, 5 and 7.
- Produces: no new exported surface. `generate` still returns the `ScriptVersion` row.

- [ ] **Step 1: Write the failing tests**

Append to `src/services/script.service.test.ts`, following the existing mocking style in that file:

```ts
describe("generate — a doodle channel", () => {
  it("refuses when the channel has not chosen a cadence", async () => {
    // A DOODLE channel with beatSeconds null. Null is a real state, not a
    // gap to fill with a default: a default would pick a rhythm for a channel
    // that never asked for one.
    await expect(
      generateFor({ footageStyle: "DOODLE", beatSeconds: null }),
    ).rejects.toThrow(/seconds per picture/i);
  });

  it("refuses a video longer than the doodle cap", async () => {
    await expect(
      generateFor({ footageStyle: "DOODLE", beatSeconds: 7 }, { duration: "12" }),
    ).rejects.toThrow(/5 minutes/i);
  });

  // The refusal must happen before the model is called, because the credit is
  // charged on the way past it.
  it("refuses before spending anything", async () => {
    await expect(
      generateFor({ footageStyle: "DOODLE", beatSeconds: null }),
    ).rejects.toThrow();

    expect(chargeVideo).not.toHaveBeenCalled();
    expect(gateway.generateScript).not.toHaveBeenCalled();
  });

  it("asks the writer for the section count the cadence implies", async () => {
    await generateFor({ footageStyle: "DOODLE", beatSeconds: 7 }, { duration: "5" });

    const { system } = gateway.generateScript.mock.calls[0][0];
    expect(system).toContain("43");
    expect(system).toContain("[still]");
  });

  it("says nothing extra to a channel that is not DOODLE", async () => {
    await generateFor({ footageStyle: "ILLUSTRATED", beatSeconds: 7 }, { duration: "5" });

    const { system } = gateway.generateScript.mock.calls[0][0];
    expect(system ?? "").not.toContain("[still]");
  });
});

describe("generate — the untagged-cue warning", () => {
  // The silent failure this exists for: 42 tags out of 43 makes isShotScripted
  // false, and the video renders 15 pictures instead of 43. It still renders,
  // still looks finished, and is quietly the wrong film.
  it("names the shortfall in the activity line when a tag is missing", async () => {
    const version = await generateFor(
      { footageStyle: "DOODLE", beatSeconds: 7 },
      { duration: "5" },
      { cues: [{ anchor: "a b c d e f g h", cue: "x", shot: "still" }, { anchor: "i j k l m n o p", cue: "y" }] },
    );

    const message = activityMessageFor(version);
    expect(message).toMatch(/1 of 2/);
    expect(message).toMatch(/regenerat/i);
  });

  it("says nothing when every section is tagged", async () => {
    const version = await generateFor(
      { footageStyle: "DOODLE", beatSeconds: 7 },
      { duration: "5" },
      { cues: [{ anchor: "a b c d e f g h", cue: "x", shot: "still" }] },
    );

    expect(activityMessageFor(version)).not.toMatch(/untagged/i);
  });
});
```

If the existing test file has no `generateFor`/`activityMessageFor` helpers, write them at the top of the new `describe` blocks: `generateFor(brand, variables?, providerResult?)` builds a video whose `project.channel.brand` is `brand`, stubs the gateway to return `providerResult` (defaulting to a valid script with every cue tagged), and calls `scriptService.generate`. `activityMessageFor` reads the activity/log row the generation wrote.

- [ ] **Step 2: Run them to verify they fail**

With the DB tunnel open, run: `npx vitest run src/services/script.service.test.ts`
Expected: FAIL — no refusal is thrown, and the system instruction contains no section count.

- [ ] **Step 3: Add the guard and the instruction**

In `src/services/script.service.ts`, import:

```ts
import {
  countUntaggedCues,
  DOODLE_MAX_SECONDS,
  doodleCadenceInstruction,
  doodleSectionCount,
} from "@/lib/doodle-cadence";
```

Immediately **before** the `const system = …` assembly at ~line 213 (and therefore before `creditService.chargeVideo`, which is what makes the "refuses before spending anything" test pass), insert:

```ts
    // The doodle format's two numbers, validated against each other in the one
    // place that has both.
    //
    // `beatSeconds` is read here and nowhere else in the app. Everything
    // downstream — footage, render, shorts — reaches the same cadence through
    // `ScriptVersion.cues`, which is what keeps the three of them from drifting
    // apart; see the column's own comment for why that matters.
    //
    // The length cap is enforced here rather than in `story-beats.ts` because
    // `MAX_BEATS` is deliberately not applied on the tagged path: capping the
    // count there would drop the last shots silently and leave the closing
    // minute with no picture over it. Capping the duration bounds the same
    // spend without ever doing that.
    const brand = video.project.channel?.brand ?? null;
    let doodleInstruction: string | null = null;

    if (brand?.footageStyle === "DOODLE") {
      const declaredMinutes =
        input.variables?.duration ??
        template.variables.find((variable) => variable.key === "duration")?.defaultValue;
      const targetSeconds = Number(declaredMinutes) * 60;

      if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) {
        throw new ValidationError(
          "A doodle video needs a duration in minutes before its pictures can be counted.",
        );
      }

      if (targetSeconds > DOODLE_MAX_SECONDS) {
        throw new ValidationError(
          `A doodle video can be at most ${DOODLE_MAX_SECONDS / 60} minutes. This format ` +
            "draws every picture, so its length is what bounds what it costs.",
        );
      }

      if (brand.beatSeconds === null) {
        throw new ValidationError(
          "This channel has no seconds per picture set. Choose one on the channel's " +
            "branding screen — it decides how many pictures the video has, and there is " +
            "no sensible default to pick on the channel's behalf.",
        );
      }

      doodleInstruction = doodleCadenceInstruction(
        doodleSectionCount(targetSeconds, brand.beatSeconds),
      );
    }
```

Then replace the `system` assignment with:

```ts
    // Two standing facts about this channel, either of which may be absent.
    // They are mutually exclusive in practice — `recurringCharacterInstruction`
    // returns null for anything but ILLUSTRATED — but joining rather than
    // choosing means neither has to know that about the other.
    const instructions = [
      recurringCharacterInstruction(brand),
      doodleInstruction,
    ].filter((line): line is string => line !== null);

    const system = instructions.length > 0 ? instructions.join("\n\n") : undefined;
```

Make sure `ValidationError` is imported from `@/lib/errors` (add it to the existing import if it is not already there).

- [ ] **Step 4: Add the warning to the activity line**

At the activity message (~line 415), replace:

```ts
            message: `Generated script v${version.version} (${version.wordCount} words)`,
```

with:

```ts
            message: doodleTagWarning(brand, version)
              ? `Generated script v${version.version} (${version.wordCount} words) — ` +
                doodleTagWarning(brand, version)
              : `Generated script v${version.version} (${version.wordCount} words)`,
```

and add, near the other module-level helpers in the file:

```ts
/**
 * The one silent failure the doodle format can produce, said out loud.
 *
 * `planStoryBeats` cuts one picture per cue only when **every** cue carries a
 * shot tag. Forty-two tags out of forty-three makes `isShotScripted` false and
 * the video renders fifteen pictures instead of forty-three — it still renders,
 * still looks finished, and is quietly the wrong film. `longform-list` can only
 * warn the model in prose; this format knows the channel is DOODLE, so it can
 * count what came back.
 *
 * A warning on the line the operator already reads, rather than a refusal.
 * `chargeVideo` is idempotent per video, so regenerating costs no credit and
 * acting on this is free — and a hard refusal would block a whole video on a
 * model formatting slip that a second attempt usually fixes.
 */
function doodleTagWarning(
  brand: { footageStyle: FootageStyle } | null,
  version: { cues: unknown },
): string | null {
  if (brand?.footageStyle !== "DOODLE") {
    return null;
  }

  const cues = Array.isArray(version.cues) ? (version.cues as unknown as ScriptCue[]) : [];
  const untagged = countUntaggedCues(cues);

  if (untagged === 0) {
    return null;
  }

  return (
    `WARNING: ${untagged} of ${cues.length} sections came back untagged, so this video ` +
    "will render one picture every twenty seconds instead of one per section. " +
    "Regenerate the script — it costs no credit."
  );
}
```

- [ ] **Step 5: Run the tests**

With the DB tunnel open, run: `npx vitest run src/services/script.service.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit && npm run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/services/script.service.ts src/services/script.service.test.ts
git commit -m "feat: spend the doodle cadence at script time, and say when a tag is missing"
```

---

### Task 9: The visual style picker

**Files:**
- Create: `src/features/channels/components/art-style-picker.tsx`
- Create: `scripts/generate-style-samples.ts`
- Modify: `src/features/channels/components/branding-form.tsx` (the `artStyle` field at ~line 482-505, and the `footageStyle` field at ~line 447-465)
- Test: `src/features/channels/components/art-style-picker.test.tsx`

**Interfaces:**
- Consumes: `ART_STYLES`/`ArtStyleId` (Task 2), `FOOTAGE_STYLES` (Task 3).
- Produces: `<StylePicker options={…} value={…} onChange={…} name={…} />` — a controlled card grid usable for both fields.

- [ ] **Step 1: Write the failing test**

Create `src/features/channels/components/art-style-picker.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StylePicker } from "@/features/channels/components/art-style-picker";

const OPTIONS = [
  { value: "flat-vector", label: "Flat vector", description: "Bold flat shapes." },
  { value: "doodle-marker", label: "Marker doodle", description: "Stick figures." },
];

describe("StylePicker", () => {
  // The reason this component exists: a <Select> shows one style's name at a
  // time, so comparing six looks meant opening the menu six times having seen
  // none of them.
  it("shows every option's name and description at once", () => {
    render(<StylePicker name="artStyle" options={OPTIONS} value={null} onChange={vi.fn()} />);

    expect(screen.getByText("Flat vector")).toBeInTheDocument();
    expect(screen.getByText("Marker doodle")).toBeInTheDocument();
    expect(screen.getByText("Bold flat shapes.")).toBeInTheDocument();
  });

  it("reports the option that was clicked", () => {
    const onChange = vi.fn();
    render(<StylePicker name="artStyle" options={OPTIONS} value={null} onChange={onChange} />);

    fireEvent.click(screen.getByRole("radio", { name: /Marker doodle/ }));

    expect(onChange).toHaveBeenCalledWith("doodle-marker");
  });

  it("marks the selected option for assistive tech, not just visually", () => {
    render(
      <StylePicker name="artStyle" options={OPTIONS} value="doodle-marker" onChange={vi.fn()} />,
    );

    expect(screen.getByRole("radio", { name: /Marker doodle/ })).toBeChecked();
  });

  // The sample images are generated by a script that costs money to run, so the
  // picker has to be useful before anyone has run it.
  it("renders without a sample image", () => {
    render(
      <StylePicker
        name="artStyle"
        options={[{ value: "x", label: "X", description: "d" }]}
        value={null}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("radio", { name: /X/ })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/features/channels/components/art-style-picker.test.tsx`
Expected: FAIL — cannot resolve the component.

- [ ] **Step 3: Write the component**

Create `src/features/channels/components/art-style-picker.tsx`. It must be a client component (`"use client"`), render a `role="radiogroup"` of cards, and each card must contain:

- an `<Image>` from `next/image` pointing at `/art-styles/<value>.webp`, with `onError` swapping it for a neutral placeholder tile so a missing sample never breaks the page;
- the label as the accessible name of a `role="radio"` control;
- the description as visible text under it.

Keyboard support comes free from using real `<input type="radio">` elements visually hidden behind the card, which is also what makes `toBeChecked()` in the test meaningful. Follow whatever card and spacing primitives `branding-form.tsx` already imports rather than introducing new ones.

Head the file with a comment saying why it exists:

```tsx
/**
 * The style picker, as a grid rather than a dropdown.
 *
 * A `<Select>` shows one option's name at a time and renders its description
 * below the field, so comparing six looks meant opening the menu six times
 * having seen none of them — for a decision that is entirely visual. This shows
 * every option at once, with a sample of what it actually draws.
 *
 * Used for both art style and footage style, which had the same control and the
 * same problem.
 *
 * Samples are static files under `public/art-styles/`, generated once by
 * `scripts/generate-style-samples.ts` and committed. Same reasoning
 * `art-styles.ts` gives for being code rather than database rows: the app ships
 * with them whether or not a seed has run. A missing file falls back to a
 * neutral tile rather than a broken image, because the picker has to work
 * before anyone has spent the thirty-five cents.
 */
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/features/channels/components/art-style-picker.test.tsx`
Expected: PASS, 4 tests.

- [ ] **Step 5: Use it in the branding form**

In `branding-form.tsx`, replace the `<Select>` in the `artStyle` field (~line 494) and the one in the `footageStyle` field (~line 455) with `<StylePicker>`, mapping `ART_STYLES` to `{ value: style.id, label: style.name, description: style.description }` and `FOOTAGE_STYLES` to `{ value: option.value, label: option.label, description: option.description }`. Keep the surrounding `FormField`/label/error wiring exactly as it is — only the control changes.

Add a `beatSeconds` number input directly under the footage-style field, shown only when `footageStyle === "DOODLE"`, with helper text computing the implied picture count live: `doodleSectionCount(300, beatSeconds)` pictures at five minutes.

- [ ] **Step 6: Write the sample generator**

Create `scripts/generate-style-samples.ts`, following the shape of the existing scripts in `scripts/`. It generates one image per entry in `ART_STYLES` using the same image provider `footage.service.ts` uses, with **one fixed subject shared by every style** — a person sitting at a desk with a cup beside them — composed through `composeArtStyle`, and writes each to `public/art-styles/<id>.webp`.

Head it with:

```ts
/**
 * Generates the style picker's samples. Run once; the output is committed.
 *
 * One fixed subject across every style, deliberately. The operator is choosing
 * between *looks*, so the subject has to be the constant — a different scene
 * per card would ask them to compare two things at once, which is the same
 * mistake the format's own A/B protocol is written to avoid.
 *
 * Seven styles at about five cents is thirty-five cents, once, ever — not per
 * channel and not per view, which is why these are files in the repository
 * rather than something generated on demand.
 */
```

- [ ] **Step 7: Verify the whole suite and the build**

Run: `npx vitest run`
Expected: PASS.

Run: `npx tsc --noEmit && npm run lint && npm run build`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/features/channels/components/art-style-picker.tsx src/features/channels/components/art-style-picker.test.tsx src/features/channels/components/branding-form.tsx scripts/generate-style-samples.ts
git commit -m "feat: pick a style by looking at it rather than by reading its name"
```

---

## After the tasks: the comparison the operator asked for

Not a code task — a dev-only run, to be done before anything is called finished.

1. Create a channel with `footageStyle: DOODLE`, `artStyle: doodle-marker`, `beatSeconds: 7`.
2. Generate a `doodle-story` script at 5 minutes. Confirm the activity line reports no untagged sections; regenerate if it does.
3. Narrate it **once**.
4. **Video A** — run the pipeline normally. Expect ~43 pictures, ~$2.15.
5. **Video B** — re-run footage and render on a copy with the cue tags stripped from the active `ScriptVersion`, so `planStoryBeats` falls back to its grouping path. Expect ~15 pictures, ~$0.75.
6. Record the footage stage's wall time for video A. Forty-three sequential generations is the one number this plan refuses to guess at; if it is unacceptable, concurrency in `collectGenerated` is the follow-up, and it is deliberately not designed here.
7. Watch both. The question is only whether the fast cut is worth the extra ~$1.40.

**Do not deploy to staging.** Dev only.
