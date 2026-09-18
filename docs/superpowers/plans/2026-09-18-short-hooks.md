# Short Hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every script of 90 seconds or less opens fresh (no formula, not the channel's last ten openings), carries a 2–6 word hook card drawn over the first three seconds of a vertical kinetic render, and ends LOOP or DEBATE alternately.

**Architecture:** All rules are pure functions in two files (`short-hook.ts` gains the opening checks, a new `short-script.ts` owns the short-target test, the card, the ending and the combined gate). `ScriptService.generate` reads the channel's recent openings and last ending, adds two system instructions, and runs the gate in a two-attempt loop exactly like the existing insight/longform loops. The card is one extra style and event appended by `buildAss`.

**Tech Stack:** TypeScript, Prisma 7, Vitest (real Postgres via the SSH tunnel on localhost:55432), AI SDK `generateObject`, libass ASS subtitles.

**Spec:** `docs/superpowers/specs/2026-09-18-short-hooks-design.md`

## Global Constraints

- Gated = format `insight`, or target length ≤ 90 seconds and format not `longform`. `seconds` variable is seconds; `duration` is minutes; neither → not gated.
- A script over 90 seconds must send the byte-identical provider request it sends today.
- Two attempts total, then `ConflictError` naming what was wrong; both attempts billed via `billedTotals`.
- Freshness window: the channel's last 10 active script versions, first three words, lowercased, punctuation stripped.
- Card: 2–6 words, no emoji, not the first sentence, no formula opener. Drawn 0.00–3.00s, 300ms fade-out, top-centre, only when `VERTICAL` and `captionMode === "kinetic"`.
- No prettier. `pnpm lint` and `pnpm typecheck` only. Never two vitest processes.
- Migration is hand-written SQL using mapped table names (`script_version`), applied by hand with `pnpm db:deploy`.

---

### Task 1: Opening checks

**Files:**
- Modify: `src/lib/short-hook.ts` (append after `checkHook`)
- Test: `src/lib/short-hook.test.ts` (append)

**Interfaces:**
- Produces: `FORMULA_OPENERS: readonly string[]`, `openingKey(sentence: string): string`, `checkFreshOpening(narration: string, recentOpenings: readonly string[]): HookCheck`

- [ ] **Step 1: Write the failing tests**

```ts
describe("checkFreshOpening", () => {
  it("refuses every formula opener", () => {
    for (const opener of FORMULA_OPENERS) {
      const result = checkFreshOpening(`${opener} the sea was a road.`, []);
      expect(result.ok).toBe(false);
    }
  });

  it("refuses an opening whose first three words match a recent one", () => {
    const result = checkFreshOpening("The wisest emperor chose his son.", [
      "The wisest emperor wrote twelve books.",
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('"the wisest emperor"');
  });

  it("ignores case and punctuation when matching", () => {
    expect(openingKey("Rome, burned — twice.")).toBe("rome burned twice");
  });

  it("accepts a fresh opening", () => {
    expect(
      checkFreshOpening("Marcus Aurelius handed Rome to a lunatic.", [
        "China burned the largest fleet on earth.",
      ]).ok,
    ).toBe(true);
  });
});
```

- [ ] **Step 2:** Run `pnpm vitest run src/lib/short-hook.test.ts` — expect FAIL (not exported).

- [ ] **Step 3: Implement**

```ts
export const FORMULA_OPENERS = [
  "did you know", "what if i told you", "have you ever", "imagine",
  "this is the story of", "meet", "ever wonder", "here's why",
  "here is why", "you won't believe", "picture this",
] as const;

export function openingKey(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");
}

export function checkFreshOpening(
  narration: string,
  recentOpenings: readonly string[],
): HookCheck {
  const hook = firstSentence(narration);
  const errors: string[] = [];
  const formula = FORMULA_OPENERS.find((opener) => startsWith(hook, opener));

  if (formula !== undefined) {
    errors.push(
      `The first sentence opens with "${formula}", a formula viewers have ` +
        `learned to scroll past. Open on the fact itself.`,
    );
  }

  const key = openingKey(hook);
  if (key.length > 0 && recentOpenings.some((recent) => openingKey(recent) === key)) {
    errors.push(
      `The first sentence opens "${key}", the same way a recent video on this ` +
        `channel opened. Use a different opening shape.`,
    );
  }

  return { ok: errors.length === 0, errors };
}
```

- [ ] **Step 4:** Run the same test — expect PASS.
- [ ] **Step 5:** `git add src/lib/short-hook.ts src/lib/short-hook.test.ts && git commit -m "feat: refuse formula and repeated openings on a short"`

### Task 2: Short-script rules

**Files:**
- Create: `src/lib/short-script.ts`
- Test: `src/lib/short-script.test.ts`

**Interfaces:**
- Consumes: `checkHook`, `checkFreshOpening`, `firstSentence`, `FORMULA_OPENERS` from Task 1.
- Produces:
  - `type EndingKind = "LOOP" | "DEBATE"`
  - `SHORT_MAX_SECONDS = 90`
  - `isShortTarget(input: { format?: "prose" | "insight" | "longform"; seconds?: string; duration?: string }): boolean`
  - `nextEndingKind(previous: EndingKind | null): EndingKind`
  - `shortInstruction(recentOpenings: readonly string[], ending: EndingKind): string`
  - `checkHookCard(card: string | undefined, narration: string): string[]`
  - `checkEnding(narration: string): string[]`
  - `checkShortScript(input: { narration: string; hookCard?: string; recentOpenings: readonly string[] }): HookCheck`

- [ ] **Step 1: Write the failing tests**

```ts
describe("isShortTarget", () => {
  it("gates insight, 45 seconds and a 1-minute duration", () => {
    expect(isShortTarget({ format: "insight" })).toBe(true);
    expect(isShortTarget({ seconds: "45" })).toBe(true);
    expect(isShortTarget({ duration: "1" })).toBe(true);
  });
  it("never gates long-form, 5 minutes, or nothing declared", () => {
    expect(isShortTarget({ format: "longform", seconds: "45" })).toBe(false);
    expect(isShortTarget({ duration: "5" })).toBe(false);
    expect(isShortTarget({})).toBe(false);
  });
});

describe("nextEndingKind", () => {
  it("alternates and starts on LOOP", () => {
    expect(nextEndingKind(null)).toBe("LOOP");
    expect(nextEndingKind("LOOP")).toBe("DEBATE");
    expect(nextEndingKind("DEBATE")).toBe("LOOP");
  });
});

describe("checkHookCard", () => {
  const narration = "Marcus Aurelius handed Rome to a lunatic. More follows.";
  it("requires a card", () => {
    expect(checkHookCard(undefined, narration)).toHaveLength(1);
  });
  it("refuses one word, seven words, emoji, and the first sentence", () => {
    expect(checkHookCard("ROME", narration)).toHaveLength(1);
    expect(checkHookCard("one two three four five six seven", narration)).toHaveLength(1);
    expect(checkHookCard("ROME FELL 💀", narration)).toHaveLength(1);
    expect(checkHookCard("Marcus Aurelius handed Rome to a lunatic.", narration).length).toBeGreaterThan(0);
  });
  it("refuses a formula opener", () => {
    expect(checkHookCard("Did you know this", narration)).toHaveLength(1);
  });
  it("accepts a short standalone card", () => {
    expect(checkHookCard("THE WISE MAN'S WORST CHOICE", narration)).toEqual([]);
  });
});

describe("checkEnding", () => {
  it("refuses a question and a call to action", () => {
    expect(checkEnding("Rome fell. Was he wrong?")).toHaveLength(1);
    expect(checkEnding("Rome fell. Comment what you think.")).toHaveLength(1);
  });
  it("accepts a flat verdict", () => {
    expect(checkEnding("Rome fell. He knew better and did it anyway.")).toEqual([]);
  });
});

describe("checkShortScript", () => {
  it("collects hook, freshness, card and ending problems together", () => {
    const result = checkShortScript({
      narration: "Did you know Rome fell? Subscribe for more.",
      hookCard: undefined,
      recentOpenings: [],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 2:** `pnpm vitest run src/lib/short-script.test.ts` — expect FAIL (module missing).

- [ ] **Step 3: Implement `src/lib/short-script.ts`**

```ts
import {
  checkFreshOpening, checkHook, firstSentence, FORMULA_OPENERS, type HookCheck,
} from "@/lib/short-hook";

export type EndingKind = "LOOP" | "DEBATE";
export const SHORT_MAX_SECONDS = 90;
const CARD_MIN_WORDS = 2;
const CARD_MAX_WORDS = 6;
const ENGAGEMENT_ASKS = ["comment", "let me know", "subscribe", "follow", "like and"];

export function isShortTarget(input: {
  format?: "prose" | "insight" | "longform"; seconds?: string; duration?: string;
}): boolean {
  if (input.format === "longform") return false;
  if (input.format === "insight") return true;
  const seconds = Number(input.seconds);
  if (input.seconds !== undefined && Number.isFinite(seconds)) return seconds <= SHORT_MAX_SECONDS;
  const minutes = Number(input.duration);
  if (input.duration !== undefined && Number.isFinite(minutes)) return minutes * 60 <= SHORT_MAX_SECONDS;
  return false;
}

export function nextEndingKind(previous: EndingKind | null): EndingKind {
  return previous === "LOOP" ? "DEBATE" : "LOOP";
}

const OPENING_SHAPES = [
  'Famous name, then the twist: "Marcus Aurelius handed Rome to a lunatic."',
  'One extreme number: "Four hundred ships burned in a single order."',
  'A flat verdict: "The wisest emperor made the dumbest choice in Rome."',
  'A scene already moving: "Soldiers rolled in and every road sign vanished."',
  'A contradiction: "The most feared destroyer saved the oldest story on earth."',
  'The stakes: "One signature decided which language Africa would speak."',
  'The object: "A clay tablet outlived the empire that burned it."',
  'The aftermath first: "The borders are still there. The men who drew them never saw them."',
];

export function shortInstruction(recentOpenings: readonly string[], ending: EndingKind): string {
  const recent = recentOpenings.length
    ? `Recent videos on this channel opened like this — open differently:\n${recentOpenings
        .map((opening) => `- ${firstSentence(opening)}`).join("\n")}`
    : "";
  const endingRule = ending === "LOOP"
    ? "ENDING: loop. The last line leads straight back into the first sentence, so a replay reads as one continuous thought."
    : "ENDING: debate. End on a flat verdict a viewer could argue with. State it; never ask it.";
  return [
    "OPENING: pick one of these shapes. Never open with a formula such as \"Did you know\".",
    ...OPENING_SHAPES.map((shape) => `- ${shape}`),
    recent,
    "HOOK CARD: also return hook_card — two to six words shown on screen for the first three seconds. It must make sense with the sound off and must not repeat the first sentence.",
    endingRule,
    "Never ask the viewer to comment, like, follow or subscribe.",
  ].filter(Boolean).join("\n");
}

const EMOJI = /\p{Extended_Pictographic}/u;
const normalise = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();

export function checkHookCard(card: string | undefined, narration: string): string[] {
  if (card === undefined || card.trim().length === 0) {
    return ["The script has no hook_card. Return two to six words for the opening screen."];
  }
  const errors: string[] = [];
  const words = card.trim().split(/\s+/).length;
  if (words < CARD_MIN_WORDS || words > CARD_MAX_WORDS) {
    errors.push(`The hook_card has ${words} words. It must have two to six.`);
  }
  if (EMOJI.test(card)) errors.push("The hook_card contains an emoji. Use words only.");
  if (normalise(card) === normalise(firstSentence(narration))) {
    errors.push("The hook_card repeats the first sentence. Say the hook a different way.");
  }
  const lowered = card.trim().toLowerCase();
  if (FORMULA_OPENERS.some((opener) => lowered.startsWith(opener))) {
    errors.push("The hook_card opens with a formula phrase. Lead with the fact.");
  }
  return errors;
}

export function checkEnding(narration: string): string[] {
  const sentences = narration.trim().split(/(?<=[.?!])\s+/);
  const last = sentences[sentences.length - 1]?.trim() ?? "";
  const lowered = last.toLowerCase();
  if (last.endsWith("?") || ENGAGEMENT_ASKS.some((ask) => lowered.includes(ask))) {
    return [`The last sentence ("${last}") asks the viewer for something. End on a statement.`];
  }
  return [];
}

export function checkShortScript(input: {
  narration: string; hookCard?: string; recentOpenings: readonly string[];
}): HookCheck {
  const errors = [
    ...checkHook(input.narration).errors,
    ...checkFreshOpening(input.narration, input.recentOpenings).errors,
    ...checkHookCard(input.hookCard, input.narration),
    ...checkEnding(input.narration),
  ];
  return { ok: errors.length === 0, errors };
}
```

- [ ] **Step 4:** Re-run — expect PASS. Then `pnpm lint src/lib/short-script.ts src/lib/short-script.test.ts`.
- [ ] **Step 5:** Commit `feat: the rules a short script's hook card and ending must pass`.

### Task 3: Schema, migration and provider field

**Files:**
- Modify: `prisma/schema.prisma` (`ScriptVersion`, new enum `EndingKind`)
- Create: `prisma/migrations/20260918090000_add_short_hook_card/migration.sql`
- Modify: `src/services/providers/types.ts` (`ScriptGenerationResult.hookCard?: string`)
- Modify: `src/services/providers/gateway.provider.ts` (`hook_card` optional on `scriptSchema` and `insightScriptSchema`; return `hookCard`)

**Interfaces:**
- Produces: `ScriptVersion.hookCard: string | null`, `ScriptVersion.endingKind: EndingKind | null`, `ScriptGenerationResult.hookCard?: string`.

- [ ] **Step 1:** Add to `ScriptVersion` after `sources`:

```prisma
  /// Two to six words drawn over the first three seconds of a vertical kinetic
  /// render (see kinetic-captions.ts). Null for every script longer than
  /// ninety seconds and every script written before this column existed.
  hookCard   String?
  /// How a short's last line was asked to land, recorded so the ending kinds
  /// can be compared against retention later. Null outside shorts.
  endingKind EndingKind?
```

and the enum:

```prisma
enum EndingKind {
  LOOP
  DEBATE
}
```

- [ ] **Step 2:** Migration SQL:

```sql
-- A short's opening card and its ending kind. Both nullable with no backfill:
-- every script written before this renders exactly as it did.
CREATE TYPE "EndingKind" AS ENUM ('LOOP', 'DEBATE');

ALTER TABLE "script_version"
  ADD COLUMN "hookCard" TEXT,
  ADD COLUMN "endingKind" "EndingKind";
```

- [ ] **Step 3:** In `gateway.provider.ts` add to both schemas:

```ts
  hook_card: z
    .string()
    .optional()
    .describe(
      "Only when asked for: two to six words shown on screen over the first " +
        "three seconds. Must make sense with the sound off.",
    ),
```

and return `hookCard` from both object branches (`result.object.hook_card`), declared beside `sources` with `let hookCard: string | undefined;`.

- [ ] **Step 4:** `pnpm db:generate && pnpm typecheck` — expect clean. Apply to the tunnelled staging DB with `pnpm db:deploy` (tests need the columns).
- [ ] **Step 5:** Commit `feat: store a short's hook card and ending kind`.

### Task 4: Gate the generation

**Files:**
- Modify: `src/services/script.service.ts`
- Test: `src/services/script.service.test.ts` (new `describe("scriptService.generate — shorts")`)

**Interfaces:**
- Consumes: Task 2's `isShortTarget`, `nextEndingKind`, `shortInstruction`, `checkShortScript`; Task 3's columns and `hookCard`.

- [ ] **Step 1: Write the failing tests** (fixture: default template declares a `seconds` variable with default `"45"`; the video needs a channel — create one with `prisma.channel.create` owned by the test user and point the project at it, following `src/test/fixtures.ts` helpers if one exists):

```ts
const good = {
  content: "Marcus Aurelius handed Rome to a lunatic. He knew better and did it anyway.",
  hookCard: "THE WISE MAN'S WORST CHOICE",
};

it("stores the hook card and a LOOP ending for the first short on a channel", async () => {
  provider.generateScript.mockResolvedValueOnce(result(good));
  const version = await service.generate(userId, videoId, {});
  expect(version.hookCard).toBe(good.hookCard);
  expect(version.endingKind).toBe("LOOP");
});

it("retries once with the gate's reasons and bills both attempts", async () => {
  provider.generateScript
    .mockResolvedValueOnce(result({ content: "Did you know Rome fell? Subscribe.", hookCard: undefined }))
    .mockResolvedValueOnce(result(good));
  await service.generate(userId, videoId, {});
  expect(provider.generateScript).toHaveBeenCalledTimes(2);
  expect(provider.generateScript.mock.calls[1][0].prompt).toContain("Your previous answer was rejected");
  const usage = await prisma.providerUsage.findFirst({ where: { model: FAKE_MODEL, succeeded: true } });
  expect(usage?.inputTokens).toBe(200);
});

it("gives up after two failures and saves nothing", async () => {
  provider.generateScript.mockResolvedValue(result({ content: "Did you know Rome fell?", hookCard: undefined }));
  await expect(service.generate(userId, videoId, {})).rejects.toBeInstanceOf(ConflictError);
  expect(await prisma.scriptVersion.count({ where: { script: { videoId } } })).toBe(0);
});

it("refuses an opening this channel used recently", async () => {
  // First video on the channel opens "Marcus Aurelius handed…"
  provider.generateScript.mockResolvedValueOnce(result(good));
  await service.generate(userId, videoId, {});
  // Second video: same opening twice → rejected
  provider.generateScript.mockResolvedValue(result(good));
  await expect(service.generate(userId, secondVideoId, {})).rejects.toBeInstanceOf(ConflictError);
});

it("alternates the ending on the next short", async () => {
  provider.generateScript.mockResolvedValueOnce(result(good));
  await service.generate(userId, videoId, {});
  provider.generateScript.mockResolvedValueOnce(result({ ...good, content: "Rome's best emperor chose his son. Rome's best emperor chose his son." }));
  const second = await service.generate(userId, secondVideoId, {});
  expect(second.endingKind).toBe("DEBATE");
});

it("sends a five-minute script exactly as before", async () => {
  await service.generate(userId, videoId, { variables: { seconds: "300" } });
  const call = provider.generateScript.mock.calls[0][0];
  expect(call.system).toBeUndefined();
  expect(provider.generateScript).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2:** Run `pnpm vitest run src/services/script.service.test.ts` — expect the new tests to FAIL, old ones PASS.

- [ ] **Step 3: Implement in `generate`:**
  1. Select `project.channelId` on the video.
  2. After `template` is loaded, compute
     ```ts
     const declared = (key: string) =>
       input.variables?.[key] ??
       template.variables.find((variable) => variable.key === key)?.defaultValue ??
       undefined;
     const short =
       isShortTarget({ format: input.format, seconds: declared("seconds"), duration: declared("duration") }) &&
       video.project.channelId !== null;
     ```
  3. If `short`, read context with one helper:
     ```ts
     private async shortContext(channelId: string, videoId: string) {
       const recent = await prisma.scriptVersion.findMany({
         where: { activeFor: { video: { id: { not: videoId }, deletedAt: null, project: { channelId } } } },
         orderBy: { createdAt: "desc" },
         take: 10,
         select: { content: true },
       });
       const last = await prisma.scriptVersion.findFirst({
         where: { endingKind: { not: null }, script: { video: { project: { channelId } } } },
         orderBy: { createdAt: "desc" },
         select: { endingKind: true },
       });
       return {
         recentOpenings: recent.map((row) => firstSentence(row.content)),
         ending: nextEndingKind(last?.endingKind ?? null),
       };
     }
     ```
  4. Push `shortInstruction(recentOpenings, ending)` onto `instructions`.
  5. Replace the prose branch with `this.generateShortProse(...)` when `short`; pass an extra check into `generateInsight` when `short`:
     ```ts
     const shortCheck = (generated: ScriptGenerationResult) =>
       checkShortScript({ narration: generated.content, hookCard: generated.hookCard, recentOpenings }).errors;
     ```
     `generateInsight` gains an optional third parameter `extraCheck?: (g) => string[]` and merges its errors with the validator's.
     `generateShortProse` is the `generateLongform` loop with `withSections: true`, `shortCheck` as the check, `SHORT_ATTEMPTS = 2`, and the give-up sentence "The script did not meet the short-video rules after 2 attempts, so nothing was saved."
  6. `gated` becomes `input.format === "insight" || input.format === "longform" || short`.
  7. In `scriptVersion.create` data add `hookCard: short ? generated.hookCard : undefined, endingKind: short ? ending : undefined`.

- [ ] **Step 4:** Run the file — all PASS. `pnpm lint src/services/script.service.ts && pnpm typecheck`.
- [ ] **Step 5:** Commit `feat: write shorts with a fresh opening, a hook card and an alternating ending`.

### Task 5: Draw the hook card

**Files:**
- Modify: `src/lib/kinetic-captions.ts` (`KineticCaptionInput.hookCard?: string`, style line, event)
- Modify: `src/services/render.service.ts` (select `hookCard`; pass it when `vertical && kinetic`)
- Test: `src/lib/kinetic-captions.test.ts`

- [ ] **Step 1: Failing tests**

```ts
it("adds a top-centre hook card for the first three seconds", () => {
  const ass = buildAss({ ...baseInput, hookCard: "The wise man's worst choice" });
  expect(ass).toContain("Style: HookCard,");
  expect(ass).toMatch(/Dialogue: 1,0:00:00\.00,0:00:03\.00,HookCard,,0,0,0,,\{\\fad\(0,300\)\}THE WISE MAN'S WORST CHOICE/);
});

it("draws no card when none is given", () => {
  expect(buildAss(baseInput)).not.toContain("HookCard");
});
```

- [ ] **Step 2:** Run `pnpm vitest run src/lib/kinetic-captions.test.ts` — FAIL.
- [ ] **Step 3:** In `header`, when `input.hookCard` is set, add after the Kinetic style:
  ```ts
  `Style: HookCard,${style.fontName},${Math.round(style.fontSize * 1.15)},${style.primaryColour},` +
    `${style.primaryColour},${style.outlineColour},&H00000000&,-1,0,0,0,` +
    `100,100,0,0,1,${style.outline + 2},${style.shadow},8,` +
    `${style.marginL},${style.marginR},${Math.round(input.height * 0.12)},1`
  ```
  and in `buildAss` append `Dialogue: 1,0:00:00.00,0:00:03.00,HookCard,,0,0,0,,{\\fad(0,300)}${escapeText(card.toUpperCase())}`. Card still drawn when the alignment is empty? No — keep the empty-alignment early return.
  In `render.service.ts`, add `hookCard: true` to the `activeVersion` select and pass `hookCard: vertical ? activeVersion?.hookCard ?? undefined : undefined` into the `buildAss` call.
- [ ] **Step 4:** Run tests — PASS; `pnpm lint` + `pnpm typecheck`.
- [ ] **Step 5:** Commit `feat: draw a short's hook card over its first three seconds`.

### Task 6: Verify

- [ ] Run `pnpm vitest run src/lib/short-hook.test.ts src/lib/short-script.test.ts src/lib/kinetic-captions.test.ts src/services/script.service.test.ts` (one process).
- [ ] `pnpm lint && pnpm typecheck`.
- [ ] Note for deploy: the migration must be applied on prod with `pnpm db:deploy` before the new image goes live, or script generation 500s on the missing column.
